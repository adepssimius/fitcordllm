import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type PartialPollAnswer,
  type PollAnswer,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { Config, CoreConfig, DiscordConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { Store } from "../store/index.js";
import { localStamp, pollAnswerContent } from "../agent/prompts.js";
import type { Profile, Profiles } from "../profile.js";
import { ThreadQueue } from "../session/queue.js";
import type { PollRequest, Schedule, Session } from "../session/types.js";
import { checkActor, type AuthzConfig } from "./authz.js";
import { classifyContent, route, type RouteDecision } from "./router.js";
import { buildThreadContext, type ContextMessage } from "./context.js";
import { startTyping } from "./typing.js";
import { ThreadStreamer, type Sendable } from "./streamer.js";
import { VoteCollector } from "./votes.js";
import { splitForDiscord } from "./render.js";

export interface BotDeps {
  readonly cfg: CoreConfig;
  readonly discord: DiscordConfig;
  readonly log: Logger;
  readonly store: Store;
  /** Everyone this bot serves. The channel a message arrives in decides whose it is. */
  readonly profiles: Profiles;
}

/** One unit of work on a session's lane. */
type Incoming =
  | {
      readonly kind: "chat";
      /** Absent when the turn was started by a poll vote rather than a typed message. */
      readonly message?: Message;
      readonly actorId: string;
      readonly authorName: string;
      readonly content: string;
      readonly session: Session;
      readonly thread: ThreadChannel;
      /**
       * The thread's prior conversation, when the bot was pulled into a thread
       * someone else opened. First turn only — afterwards the SDK session
       * carries it and re-sending would pay for the same tokens every turn.
       */
      readonly threadContext?: string;
    }
  | {
      readonly kind: "brief";
      readonly schedule: Schedule;
      readonly session: Session;
      readonly channel: TextChannel;
      /** Already posted; the brief replaces it in place. */
      readonly placeholder: Message;
    };

const STOP_WORDS = new Set(["stop", "!stop", "/stop", "cancel", "abort"]);
/** Answered from the database, without a model turn. */
const THREADS_WORDS = new Set(["threads", "status"]);
const SCHEDULES_WORDS = new Set(["schedules", "briefs"]);

const BRIEF_FOOTER = "-# Reply to this message, or start a thread from it, to continue.";

/** A profile's answer to "who may talk here" — see authz.ts. */
function authzOf(cfg: Config): AuthzConfig {
  return {
    userIds: cfg.DISCORD_CHAT_USER_IDS,
    roleIds: cfg.DISCORD_CHAT_ROLE_IDS,
    channelGated: cfg.DISCORD_CHAT_CHANNEL_IDS.length > 0,
  };
}

export class DiscordBot {
  private readonly client: Client;
  /**
   * The integration role Discord creates for this bot, if it exists.
   *
   * Mentioning it is visually identical to mentioning the bot user — the two
   * sit next to each other in the client's autocomplete — but it arrives as
   * `<@&id>` in `mention_roles`, not as a user mention.
   */
  private ownRoleId: string | null = null;
  private readonly queue: ThreadQueue<Incoming>;
  private readonly votes: VoteCollector;

  constructor(private readonly deps: BotDeps) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        // Privileged. Without it, messages inside a thread arrive with empty
        // content and only @mentions are readable — which breaks the
        // "every message in a bot thread is a prompt" model.
        GatewayIntentBits.MessageContent,
        // Not privileged. Without it a tap on a poll never reaches the bot.
        GatewayIntentBits.GuildMessagePolls,
      ],
      // After a restart the poll's message is not cached; without the poll
      // partials a vote on it is silently dropped.
      partials: [Partials.Message, Partials.Channel, Partials.Poll, Partials.PollAnswer],
    });

    this.votes = new VoteCollector({
      settleMs: deps.cfg.POLL_SETTLE_MS,
      multiSettleMs: deps.cfg.POLL_MULTI_SETTLE_MS,
      onSettled: (vote) => {
        void this.onVoteSettled(vote).catch((e: unknown) =>
          deps.log.error({ err: e, poll: vote.messageId }, "poll answer handler failed"),
        );
      },
    });

    this.queue = new ThreadQueue<Incoming>((head, rest) => this.runTurn(head, rest), {
      maxPending: deps.discord.CHAT_PENDING_MAX,
      onError: (key, e) => deps.log.error({ err: e, thread: key }, "turn handler failed"),
    });

    for (const p of deps.profiles.all) {
      p.manager.onRunScheduleNow((s) => {
        void this.postBrief(s).catch((e: unknown) => deps.log.error({ err: e, schedule: s.name }, "brief failed"));
      });
    }
  }

  /**
   * Connects, then tells any thread whose answer was cut off by the restart.
   *
   * Nothing is retried on its own — the question may be stale — but a thread
   * left on "working…" with no word is the one outcome that makes a restart
   * look like data loss, when the clone and the conversation are both intact.
   */
  async start(interrupted: readonly Session[] = []): Promise<void> {
    const { log, discord } = this.deps;

    this.client.once(Events.ClientReady, (c) => {
      log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, "discord connected");
      void this.resolveOwnRole().catch((e: unknown) =>
        log.warn({ err: e }, "could not resolve the bot's managed role"),
      );
      void this.announceRecovery(interrupted);
    });
    this.client.on(Events.Error, (e) => log.error({ err: e }, "discord client error"));
    this.client.on(Events.MessageCreate, (m) => {
      void this.onMessage(m).catch((e: unknown) => log.error({ err: e }, "message handler failed"));
    });

    this.client.on(Events.MessagePollVoteAdd, (answer, userId) => {
      void this.onVote(answer, userId, true).catch((e: unknown) => log.error({ err: e }, "vote handler failed"));
    });
    this.client.on(Events.MessagePollVoteRemove, (answer, userId) => {
      void this.onVote(answer, userId, false).catch((e: unknown) => log.error({ err: e }, "vote handler failed"));
    });

    await this.client.login(discord.DISCORD_BOT_TOKEN);
  }

  /** Gateway connectivity, for the readiness probe. */
  isConnected(): boolean {
    return this.client.isReady();
  }

  async stop(): Promise<void> {
    this.votes.clear();
    await this.client.destroy();
  }

  private async announceRecovery(interrupted: readonly Session[]): Promise<void> {
    for (const s of interrupted) {
      const ch = await this.client.channels.fetch(s.threadId).catch(() => null);
      if (!ch?.isThread()) continue;
      await ch
        .send(
          "I was restarted while working on your last message, so it went unanswered. This thread, " +
            "its files and what we discussed are all intact — send it again and I'll pick up from there.",
        )
        .catch(() => undefined);
    }
  }

  /**
   * Finds the managed role whose `tags.bot_id` is this bot.
   *
   * Matching on the tag rather than the role name: the name is editable by any
   * server admin, the tag is not.
   */
  private async resolveOwnRole(): Promise<void> {
    const { discord, log } = this.deps;
    const me = this.client.user;
    if (!me) return;
    const guild = await this.client.guilds.fetch(discord.DISCORD_GUILD_ID);
    const roles = await guild.roles.fetch();
    const own = roles.find((r) => r.managed && r.tags?.botId === me.id);
    this.ownRoleId = own?.id ?? null;
    if (own) log.info({ roleId: own.id, name: own.name }, "resolved the bot's managed role");
  }

  /**
   * Whether this message addresses the bot.
   *
   * `ignoreRoles` stays on so an @everyone or a broad role ping never starts a
   * turn, but the bot's *own* integration role is exempt: it has exactly one
   * member — the bot — so a mention of it can only be aimed here.
   */
  private addressesMe(message: Message): boolean {
    if (this.client.user === null) return false;
    const direct = message.mentions.has(this.client.user, {
      ignoreEveryone: true,
      ignoreRoles: true,
      ignoreRepliedUser: true,
    });
    if (direct) return true;
    return this.ownRoleId !== null && message.mentions.roles.has(this.ownRoleId);
  }

  private async onMessage(message: Message): Promise<void> {
    const { discord, log, store, profiles } = this.deps;

    const inThread = message.channel.isThread();

    // A thread started from a brief carries the id of the message it was
    // started from, so the brief's session is found by that id even though no
    // thread existed when it was filed.
    const anchored = inThread ? store.sessions.byAnchor(message.channel.id) : undefined;
    const known = inThread ? (store.sessions.byThread(message.channel.id) ?? anchored) : undefined;

    // The other way to continue a brief: reply to it in the channel.
    const repliedTo = !inThread ? message.reference?.messageId : undefined;
    const briefSession = repliedTo
      ? (store.sessions.byAnchor(repliedTo) ?? this.briefByThread(repliedTo))
      : undefined;

    const mentioned = this.addressesMe(message);

    const decision = route({
      authorIsBot: message.author.bot,
      isWebhook: message.webhookId !== null,
      guildId: message.guild?.id ?? null,
      expectedGuildId: discord.DISCORD_GUILD_ID,
      inThread,
      knownSession: known !== undefined,
      mentioned,
      channelId: message.channelId,
      parentChannelId: inThread ? (message.channel.parentId ?? undefined) : undefined,
      allowedChannels: profiles.channels,
      repliesToBrief: briefSession !== undefined,
    });

    if (decision.action === "ignore") {
      // An ignored mention is a silent no-op the human can *see the absence of*,
      // so it belongs at info. Everything else is ordinary channel traffic.
      const level = mentioned ? "info" : "debug";
      log[level](
        { reason: decision.reason, channel: message.channelId, user: message.author.id },
        mentioned ? "mentioned but not answered" : "message ignored",
      );
      return;
    }

    // route() already excluded guild-less messages; narrowing for the compiler.
    const guildId = message.guild?.id;
    if (!guildId) return;

    // Whose conversation this is. A known session says; otherwise the channel
    // it arrived in (the parent, for a thread) does.
    const session0 = known ?? briefSession;
    const profile = session0
      ? profiles.named(session0.profile)
      : profiles.forChannel(inThread ? (message.channel.parentId ?? message.channelId) : message.channelId);
    if (!profile) {
      log.info({ channel: message.channelId }, "mentioned in a channel no profile owns");
      return;
    }
    const { manager } = profile;

    // Authorisation is checked HERE, before any thread is opened: refusing
    // afterwards would let anyone who can see the channel make the bot open
    // threads by being unwelcome at it. The allowlist is the profile's own:
    // being allowed in one person's channel says nothing about another's.
    const actor = checkActor(authzOf(profile.cfg),
      {
        userId: message.author.id,
        roleIds: message.member ? [...message.member.roles.cache.keys()] : [],
      },
    );
    if (!actor.allowed) {
      log.warn({ user: message.author.id, reason: actor.reason }, "unauthorised chat attempt");
      await message.react("🚫").catch(() => undefined);
      return;
    }

    // Bound only now, after authorisation: binding closes the brief's other
    // doors, and that is not something a passer-by should be able to cause by
    // starting a thread on it.
    if (anchored) {
      store.sessions.bindThread(anchored.id, message.channel.id);
      log.info({ sessionId: anchored.id, threadId: message.channel.id }, "brief continued as a thread");
    }

    const content = this.strip(message.content);
    const kind = classifyContent({
      raw: message.content,
      stripped: content,
      hasAttachments: message.attachments.size > 0,
    });

    if (kind === "unreadable") {
      await message
        .reply(
          "I received a message with no readable content. If this keeps happening, the " +
            "**Message Content** privileged intent is probably off in the Discord developer portal.",
        )
        .catch(() => undefined);
      return;
    }

    const word = content.toLowerCase();

    // Answered from the database: no thread, no model turn, nothing spent.
    if (decision.action === "open" && THREADS_WORDS.has(word)) {
      await this.replyChunks(message, await this.threadsReport(profile));
      return;
    }
    if (decision.action === "open" && SCHEDULES_WORDS.has(word)) {
      await this.replyChunks(message, this.schedulesReport(profile));
      return;
    }

    if (known && STOP_WORDS.has(word)) {
      // Only while something is running. The abort flag is cleared when a turn
      // ends, so setting it on an idle thread would instead kill the NEXT
      // message the moment it started.
      if (this.queue.isRunning(known.id)) {
        manager.abort(known.id);
        await message.react("🛑").catch(() => undefined);
      } else {
        await message.react("🤷").catch(() => undefined);
      }
      return;
    }

    const bound = await this.establish(profile, decision, message, known, briefSession, guildId, content);
    if (!bound) return;
    const { session, thread } = bound;

    if (kind === "bare-mention") {
      // The session is established, so the question they type next lands
      // without needing a second mention.
      await thread.send("I'm here — what do you need? Ask away in this thread.").catch(() => undefined);
      return;
    }

    // Joining someone else's thread: read what is already there.
    const threadContext = bound.adopted ? await this.readThread(thread, message.id) : undefined;

    const r = this.queue.enqueue(session.id, {
      kind: "chat",
      message,
      actorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.username,
      content,
      session,
      thread,
      ...(threadContext ? { threadContext } : {}),
    });
    if (!r.accepted) {
      await message.react("🚫").catch(() => undefined);
      await thread
        .send("I'm still working and your queue is full — I'll answer what's queued first.")
        .catch(() => undefined);
      return;
    }
    if (r.queued) await message.react("👀").catch(() => undefined);
  }

  /** A brief session that already has a thread, looked up by that thread's id. */
  private briefByThread(messageId: string): Session | undefined {
    const s = this.deps.store.sessions.byThread(messageId);
    return s?.kind === "brief" ? s : undefined;
  }

  /** Removes the ways this message can address the bot, leaving the prompt. */
  private strip(content: string): string {
    const tokens = [this.client.user?.id, this.ownRoleId].filter(
      (x): x is string => typeof x === "string",
    );
    let out = content;
    for (const id of tokens) out = out.replace(new RegExp(`<@[!&]?${id}>`, "g"), " ");
    return out.trim();
  }

  /**
   * Resolves a routed message to a thread and its session, opening, adopting
   * or continuing as the decision requires.
   */
  private async establish(
    profile: Profile,
    decision: Exclude<RouteDecision, { action: "ignore" }>,
    message: Message,
    known: Session | undefined,
    briefSession: Session | undefined,
    guildId: string,
    title: string,
  ): Promise<{ session: Session; thread: ThreadChannel; adopted: boolean } | undefined> {
    const { log } = this.deps;
    const { manager } = profile;

    if (decision.action === "continue" && known) {
      return { session: known, thread: message.channel as ThreadChannel, adopted: false };
    }

    if (decision.action === "brief" && briefSession) {
      const thread = await this.briefThread(briefSession, message);
      if (!thread) return undefined;
      // Re-read: binding may have changed which thread the session points at.
      const session = this.deps.store.sessions.byId(briefSession.id) ?? briefSession;
      return { session, thread, adopted: false };
    }

    if (decision.action === "adopt") {
      // Someone opened a thread and mentioned us. Bind a session to the thread
      // that already exists rather than opening another one.
      const thread = message.channel as ThreadChannel;
      const session = manager.openChat({
        guildId,
        channelId: thread.parentId ?? message.channelId,
        threadId: thread.id,
        openedBy: message.author.id,
        title: thread.name.slice(0, 90) || title.slice(0, 90) || "chat",
      });
      log.info({ sessionId: session.id, threadId: thread.id }, "adopted an existing thread");
      return { session, thread, adopted: true };
    }

    const thread = await this.openThread(message, title);
    if (!thread) return undefined;
    // Thread first, then the row: a thread with no row is recoverable, a row
    // with no thread is not.
    const session = manager.openChat({
      guildId,
      channelId: message.channelId,
      threadId: thread.id,
      openedBy: message.author.id,
      title: title.slice(0, 90) || "chat",
    });
    log.info(
      { sessionId: session.id, profile: profile.cfg.name, threadId: thread.id, branch: session.branch },
      "chat session opened",
    );
    return { session, thread, adopted: false };
  }

  /**
   * The thread a brief continues in, created from the brief's message if it
   * does not exist yet.
   *
   * `reply` is the channel message that asked to continue, when there is one.
   * A poll vote has none: the brief's own message is then found by the id the
   * session is filed under.
   */
  private async briefThread(session: Session, reply?: Message): Promise<ThreadChannel | undefined> {
    const { log, store } = this.deps;

    const existing = await this.client.channels.fetch(session.threadId).catch(() => null);
    if (existing?.isThread()) return existing;

    try {
      let brief: Message;
      if (reply) {
        brief = await reply.fetchReference();
      } else {
        const channel = await this.client.channels.fetch(session.channelId);
        if (!channel?.isTextBased()) throw new Error("the brief's channel is not a text channel");
        brief = await channel.messages.fetch(session.threadId);
      }
      const thread = brief.hasThread && brief.thread
        ? brief.thread
        : await brief.startThread({ name: session.title.slice(0, 90) || "brief", autoArchiveDuration: 1440 });
      store.sessions.bindThread(session.id, thread.id);
      log.info({ sessionId: session.id, threadId: thread.id }, "brief continued in a thread");
      return thread as ThreadChannel;
    } catch (e) {
      log.error({ err: e, sessionId: session.id }, "could not open a thread on the brief");
      await reply?.reply("I couldn't open a thread on that brief — check my permissions.").catch(() => undefined);
      return undefined;
    }
  }

  /**
   * Posts the polls a turn asked for, under the reply it just delivered.
   *
   * After the reply, not during the turn: a poll sent from inside the tool
   * call would land above the answer that introduces it.
   */
  private async postPolls(
    target: Sendable,
    targetId: string,
    session: Session,
    polls: readonly PollRequest[],
  ): Promise<string[]> {
    const { cfg, log, store } = this.deps;
    const ids: string[] = [];
    for (const p of polls) {
      try {
        const msg = await target.send({
          poll: {
            question: { text: p.question },
            answers: p.options.map((text) => ({ text })),
            duration: cfg.POLL_DURATION_HOURS,
            allowMultiselect: p.multi,
          },
        });
        store.polls.create({
          messageId: msg.id,
          sessionId: session.id,
          channelId: targetId,
          key: p.key,
          question: p.question,
          options: p.options,
          multi: p.multi,
        });
        ids.push(msg.id);
        log.info({ sessionId: session.id, poll: msg.id, key: p.key }, "poll posted");
      } catch (e) {
        // Usually the Create Polls permission. Say so where the person will
        // see it, rather than leaving them waiting for a poll that never came.
        log.error({ err: e, sessionId: session.id, key: p.key }, "could not post a poll");
        await target
          .send(`I couldn't post the poll "${p.question}" — I may be missing the **Create Polls** permission here.`)
          .catch(() => undefined);
      }
    }
    return ids;
  }

  /** One tap on a poll. Only taps by someone allowed to use the bot count. */
  private async onVote(answer: PollAnswer | PartialPollAnswer, userId: string, added: boolean): Promise<void> {
    const { discord, log, store } = this.deps;

    const messageId = answer.poll.messageId;
    const poll = store.polls.byMessage(messageId);
    if (!poll || poll.answeredAt !== null) return; // not ours, or already answered
    const session = store.sessions.byId(poll.sessionId);
    if (!session) return;
    const { cfg: owner } = this.deps.profiles.named(session.profile);

    // A poll in a private channel can only be tapped by someone in it, so a
    // channel-gated profile needs no further check; an allowlist does.
    const authz = authzOf(owner);
    let allowed = checkActor(authz, { userId, roleIds: [] }).allowed;
    if (!allowed && authz.roleIds.length > 0) {
      const guild = await this.client.guilds.fetch(discord.DISCORD_GUILD_ID).catch(() => null);
      const member = await guild?.members.fetch(userId).catch(() => null);
      allowed = checkActor(authz, { userId, roleIds: member ? [...member.roles.cache.keys()] : [] }).allowed;
    }
    if (!allowed) {
      // Anyone who can see the channel can tap a poll. Their tap must not
      // become a turn on the operator's subscription.
      log.info({ user: userId, poll: messageId }, "ignored a poll vote from someone not on the allowlist");
      return;
    }

    if (added) this.votes.add(messageId, userId, answer.id, poll.multi);
    else this.votes.remove(messageId, userId, answer.id, poll.multi);
  }

  /** A vote that has stopped changing: record it, close the poll, and hand it to the agent. */
  private async onVoteSettled(vote: { messageId: string; userId: string; answerIds: number[] }): Promise<void> {
    const { discord, log, store } = this.deps;

    const poll = store.polls.byMessage(vote.messageId);
    if (!poll) return;
    // Discord numbers a poll's answers from 1, in the order they were given.
    const chosen = vote.answerIds.map((id) => poll.options[id - 1]).filter((x): x is string => x !== undefined);
    if (chosen.length === 0) return;
    if (!store.polls.answer(vote.messageId, chosen)) return; // answered already; nothing to start

    const session = store.sessions.byId(poll.sessionId);
    if (!session) return;

    // Close it, so the poll shows as answered instead of sitting open for a
    // day. Best effort: a poll left open is untidy, not wrong.
    const where = await this.client.channels.fetch(poll.channelId).catch(() => null);
    if (where?.isTextBased()) {
      const msg = await where.messages.fetch(vote.messageId).catch(() => null);
      await msg?.poll?.end().catch(() => undefined);
    }

    const thread =
      session.kind === "brief"
        ? await this.briefThread(session)
        : await this.client.channels.fetch(session.threadId).then(
            (c) => (c?.isThread() ? c : undefined),
            () => undefined,
          );
    if (!thread) {
      log.error({ sessionId: session.id, poll: vote.messageId }, "poll answered but its thread is gone");
      return;
    }

    const guild = await this.client.guilds.fetch(discord.DISCORD_GUILD_ID).catch(() => null);
    const member = await guild?.members.fetch(vote.userId).catch(() => null);

    log.info({ sessionId: session.id, poll: vote.messageId, key: poll.key, chosen }, "poll answered");
    const r = this.queue.enqueue(session.id, {
      kind: "chat",
      actorId: vote.userId,
      authorName: member?.displayName ?? "The person",
      content: pollAnswerContent(poll, chosen),
      // Re-read: a brief's session may just have been bound to its thread.
      session: store.sessions.byId(session.id) ?? session,
      thread,
    });
    if (!r.accepted) {
      await thread
        .send(`I got your answer to "${poll.question}" but my queue here is full — tell me again in a moment.`)
        .catch(() => undefined);
    }
  }

  /**
   * Reads a thread's existing conversation, for the case where the bot is being
   * pulled into one it did not open.
   *
   * Includes the starter message explicitly: for a thread created from a
   * channel post, that message lives in the parent channel and does NOT come
   * back from the thread's own message list. It is also the most useful one.
   *
   * Best effort throughout. Failing to read history is a worse answer, not a
   * broken one, so nothing here is allowed to abort the turn.
   */
  private async readThread(thread: ThreadChannel, excludeId: string): Promise<string | undefined> {
    const { log } = this.deps;
    try {
      const collected: ContextMessage[] = [];

      const toContext = (m: Message): ContextMessage => ({
        authorName: m.member?.displayName ?? m.author.username,
        authorIsBot: m.author.bot,
        content: m.content,
        embeds: m.embeds.map((e) => ({
          title: e.title,
          description: e.description,
          fields: e.fields.map((f) => ({ name: f.name, value: f.value })),
        })),
        createdTimestamp: m.createdTimestamp,
      });

      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter) collected.push(toContext(starter));

      const fetched = await thread.messages.fetch({ limit: 40 });
      for (const m of fetched.values()) {
        // Skip the message that triggered this turn: it is the prompt, and
        // repeating it as history invites the model to answer it twice.
        if (m.id === excludeId) continue;
        if (starter && m.id === starter.id) continue;
        collected.push(toContext(m));
      }

      const built = buildThreadContext(collected, { threadName: thread.name });
      log.info(
        { threadId: thread.id, messages: collected.length, chars: built.length },
        "read thread history for an adopted thread",
      );
      return built || undefined;
    } catch (e) {
      log.warn({ err: e, threadId: thread.id }, "could not read thread history");
      return undefined;
    }
  }

  private async openThread(message: Message, content: string): Promise<ThreadChannel | undefined> {
    const parent = message.channel;
    if (parent.type !== ChannelType.GuildText && parent.type !== ChannelType.GuildAnnouncement) {
      await message.reply("I can only open a thread from a normal text channel.").catch(() => undefined);
      return undefined;
    }
    try {
      return await message.startThread({
        name: content.slice(0, 90) || "chat",
        autoArchiveDuration: 1440,
      });
    } catch (e) {
      this.deps.log.error({ err: e }, "could not open a thread");
      await message.reply("I couldn't open a thread here — check my permissions.").catch(() => undefined);
      return undefined;
    }
  }

  private async replyChunks(message: Message, text: string): Promise<void> {
    const chunks = splitForDiscord(text);
    const first = chunks[0];
    if (!first) return;
    await message.reply(first).catch(() => undefined);
    for (const rest of chunks.slice(1)) {
      if (message.channel.isSendable()) await message.channel.send(rest).catch(() => undefined);
    }
  }

  /**
   * What every open conversation is holding: its branch, what it has not
   * shipped, and how far behind the base branch it is. The answer to "where
   * did I leave that?", from the database and the clones, at no model cost.
   */
  private async threadsReport(profile: Profile): Promise<string> {
    const { store } = this.deps;
    const { cfg, workspaces } = profile;
    const sessions = store.sessions.recent(cfg.name, 25);
    if (sessions.length === 0) return "No threads yet. Mention me with a question to start one.";

    const lines: string[] = [];
    let holding = 0;
    for (const s of sessions) {
      const when = localStamp(new Date(s.lastTurnAt ?? s.createdAt), cfg.BOT_TIMEZONE);
      let state = "clone removed (idle, nothing unshipped) — it comes back when you write in the thread";
      if (await workspaces.exists(s.id)) {
        try {
          const st = await workspaces.status(s);
          const parts = [
            st.unshipped.length === 0 ? "nothing unshipped" : `**${st.unshipped.length} unshipped file(s)**`,
          ];
          if (st.behind > 0) parts.push(`${st.behind} behind ${st.base}`);
          if (st.merging) parts.push("merge unfinished");
          if (st.unshipped.length > 0) holding += 1;
          state = parts.join(" · ");
        } catch {
          state = "clone unreadable";
        }
      }
      // A chat session's id is a thread. A brief's is the message it was posted
      // as — which may or may not have a thread yet — so link the message, and
      // the thread, if there is one, hangs off it.
      const where =
        s.kind === "brief"
          ? `https://discord.com/channels/${s.guildId}/${s.channelId}/${s.threadId}`
          : `<#${s.threadId}>`;
      const label = s.kind === "brief" ? `brief · ${s.title}` : s.title;
      lines.push(`- ${where} ${label}\n  \`${s.branch}\` · ${state} · last active ${when}`);
    }

    const head =
      holding === 0
        ? `**${sessions.length} thread(s)**, none holding unshipped work.`
        : `**${sessions.length} thread(s)**, ${holding} holding unshipped work.`;
    return `${head}\n${lines.join("\n")}`;
  }

  private schedulesReport(profile: Profile): string {
    const { store } = this.deps;
    const { cfg } = profile;
    const all = store.schedules.list(cfg.name);
    if (all.length === 0) {
      return "No scheduled briefs. Ask me in a thread — e.g. “send me the morning brief every day at 6”.";
    }
    return all
      .map((s) => {
        const next = s.nextRunAt ? localStamp(new Date(s.nextRunAt), cfg.BOT_TIMEZONE) : "never";
        return `- **${s.name}** \`${s.cron}\`${s.enabled ? "" : " (paused)"} · next ${next}`;
      })
      .join("\n");
  }

  /**
   * Scheduler ingress. Posts a placeholder to the channel, opens a session
   * keyed on that message, and produces the brief in its place.
   *
   * Message first, then the row — the same rule as a chat thread, and for the
   * same reason. The message's id is also what makes the brief continuable:
   * a thread started from a message takes that message's id, so the session
   * is already filed under the thread that does not exist yet.
   */
  async postBrief(schedule: Schedule): Promise<void> {
    const { discord, log, profiles } = this.deps;
    const profile = profiles.named(schedule.profile);
    const { manager } = profile;

    const channelId =
      schedule.channelId ?? profile.cfg.DISCORD_BRIEF_CHANNEL_ID ?? profile.cfg.DISCORD_CHAT_CHANNEL_IDS[0];
    if (!channelId) {
      log.error({ schedule: schedule.name, profile: schedule.profile }, "no channel for briefs — set DISCORD_BRIEF_CHANNEL_ID");
      return;
    }
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      log.error({ channel: channelId, schedule: schedule.name }, "brief channel is missing or not a text channel");
      return;
    }

    const placeholder = await channel.send(`**${schedule.name}** — _working…_`).catch((e: unknown) => {
      log.error({ err: e, schedule: schedule.name }, "could not post the brief placeholder");
      return null;
    });
    if (!placeholder) return;

    const session = manager.openBrief({
      guildId: discord.DISCORD_GUILD_ID,
      channelId: channel.id,
      anchorId: placeholder.id,
      schedule,
    });
    log.info({ sessionId: session.id, schedule: schedule.name, branch: session.branch }, "brief started");

    this.queue.enqueue(session.id, { kind: "brief", schedule, session, channel, placeholder });
  }

  private async runTurn(head: Incoming, rest: readonly Incoming[]): Promise<void> {
    // Typing starts here so every turn kind gets it. It deliberately spans the
    // quota wait too: waiting on the semaphore is still "working on it" from
    // where the person sits.
    const target = head.kind === "chat" ? head.thread : head.channel;
    const stopTyping = startTyping(target, {
      onError: (e) => this.deps.log.debug({ err: e }, "typing indicator failed"),
    });
    try {
      if (head.kind === "brief") return await this.runBrief(head);
      const chatRest = rest.filter((r): r is Extract<Incoming, { kind: "chat" }> => r.kind === "chat");
      return await this.runChat(head, chatRest);
    } finally {
      stopTyping();
    }
  }

  private async runBrief(head: Extract<Incoming, { kind: "brief" }>): Promise<void> {
    const { discord, log, store } = this.deps;
    const { manager } = this.deps.profiles.named(head.session.profile);
    const streamer = new ThreadStreamer(
      head.channel,
      { intervalMs: discord.DISCORD_EDIT_INTERVAL_MS, maxMessages: discord.DISCORD_MAX_MESSAGES_PER_TURN },
      head.placeholder,
    );

    const result = await manager.runBriefTurn(head.session, head.schedule, {
      onText: (t) => streamer.onText(t),
      onToolUse: (n, i) => streamer.onToolUse(n, i),
    });

    if (result.blocked) {
      // A degraded brief beats a placeholder stuck on "working…" all day.
      await streamer.finish(`**${head.schedule.name}** did not run. ${result.message}`);
      return;
    }

    const delivered = await streamer.finish(`${result.text}\n\n${BRIEF_FOOTER}`);
    // Every chunk is a door back into this session: whichever message the
    // person threads from or replies to, it resolves here.
    const pollIds = await this.postPolls(head.channel, head.channel.id, head.session, result.polls);
    // A poll is part of the brief: threading from it or replying to it
    // continues the same conversation.
    store.sessions.addAnchors(head.session.id, [...delivered.ids, ...pollIds]);
    if (delivered.firstId) manager.markDelivered(result.turnId, delivered.firstId);

    log.info(
      {
        sessionId: head.session.id,
        schedule: head.schedule.name,
        ok: result.ok,
        agentTurns: result.numTurns,
        costUsd: result.costUsd,
      },
      "brief complete",
    );
  }

  private async runChat(
    head: Extract<Incoming, { kind: "chat" }>,
    rest: readonly Extract<Incoming, { kind: "chat" }>[],
  ): Promise<void> {
    const { discord, log, store } = this.deps;
    const { manager } = this.deps.profiles.named(head.session.profile);
    const streamer = new ThreadStreamer(head.thread, {
      intervalMs: discord.DISCORD_EDIT_INTERVAL_MS,
      maxMessages: discord.DISCORD_MAX_MESSAGES_PER_TURN,
    });

    // Re-read: counters and agentSessionId may have moved since enqueue.
    const session = store.sessions.byId(head.session.id) ?? head.session;

    const result = await manager.runChatTurn(
      {
        session,
        trigger: session.turnCount === 0 ? "mention" : "thread_message",
        actorId: head.actorId,
        message: {
          authorDisplayName: head.authorName,
          content: head.content,
          ...(rest.length > 0 ? { coalescedWith: rest.map((r) => r.content) } : {}),
          ...(head.threadContext ? { threadContext: head.threadContext } : {}),
        },
      },
      {
        onText: (t) => streamer.onText(t),
        onToolUse: (n, i) => streamer.onToolUse(n, i),
      },
    );

    if (result.blocked) {
      await head.thread.send(result.message).catch(() => undefined);
      await head.message?.react("❌").catch(() => undefined);
      return;
    }

    const prefix: string[] = [];
    if (result.contextRebuilt) {
      prefix.push("_My record of this conversation was lost, so I'm working from a short recap. The files are intact._");
    }
    if (result.workspaceCreated && session.turnCount > 0) {
      prefix.push("_This thread's clone had been cleaned up (idle, nothing unshipped), so I checked out a fresh one._");
    }

    const body = [...prefix, result.text].filter((s) => s.length > 0).join("\n\n");
    const delivered = await streamer.finish(body);
    if (delivered.firstId) manager.markDelivered(result.turnId, delivered.firstId);
    await this.postPolls(head.thread, head.thread.id, session, result.polls);

    log.info(
      {
        sessionId: session.id,
        turnId: result.turnId,
        ok: result.ok,
        agentTurns: result.numTurns,
        costUsd: result.costUsd,
        denied: result.deniedTools,
      },
      "chat turn complete",
    );
  }
}

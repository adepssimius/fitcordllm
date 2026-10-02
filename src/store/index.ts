import { openDb, transaction, type Db } from "./db.js";
import { createSessionDao, type SessionDao } from "./sessions.js";
import { createTurnDao, type TurnDao } from "./turns.js";
import { createScheduleDao, type ScheduleDao } from "./schedules.js";
import { createStateDao, type StateDao } from "./state.js";

export interface Store {
  readonly sessions: SessionDao;
  readonly turns: TurnDao;
  readonly schedules: ScheduleDao;
  readonly state: StateDao;
  tx<T>(fn: () => T): T;
  close(): void;
  readonly raw: Db;
}

export function openStore(path: string): Store {
  const db = openDb(path);
  return {
    sessions: createSessionDao(db),
    turns: createTurnDao(db),
    schedules: createScheduleDao(db),
    state: createStateDao(db),
    tx: (fn) => transaction(db, fn),
    close: () => db.close(),
    raw: db,
  };
}

export type { SessionDao, TurnDao, ScheduleDao, StateDao };

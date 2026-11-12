import type { Db } from "./db.js";
import type { Person } from "../session/types.js";

interface RawPerson {
  profile: string;
  user_id: string;
  name: string;
  role: string;
  updated_by: string | null;
  updated_at: number;
}

function hydrate(r: RawPerson): Person {
  return {
    profile: r.profile,
    userId: r.user_id,
    name: r.name,
    role: r.role,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export interface PeopleDao {
  /** One profile's roster, by name. */
  list(profile: string): readonly Person[];
  get(profile: string, userId: string): Person | undefined;
  /** Records who someone is, replacing what was said before. */
  set(row: Pick<Person, "profile" | "userId" | "name" | "role" | "updatedBy">, now?: number): Person;
  /** Returns false when they were not on the roster. */
  remove(profile: string, userId: string): boolean;
  /**
   * Keeps the stored display name current, so the roster follows a change of
   * Discord display name. Leaves the role and its author alone; a no-op for anyone
   * not on the roster.
   */
  rename(profile: string, userId: string, name: string): void;
}

export function createPeopleDao(db: Db): PeopleDao {
  const selAll = db.prepare("SELECT * FROM people WHERE profile = ? ORDER BY name COLLATE NOCASE, user_id");
  const sel = db.prepare("SELECT * FROM people WHERE profile = ? AND user_id = ?");
  const up = db.prepare(
    `INSERT INTO people (profile, user_id, name, role, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile, user_id) DO UPDATE SET
       name = excluded.name, role = excluded.role,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );
  const del = db.prepare("DELETE FROM people WHERE profile = ? AND user_id = ?");
  const ren = db.prepare("UPDATE people SET name = ? WHERE profile = ? AND user_id = ? AND name <> ?");

  const dao: PeopleDao = {
    list(profile) {
      return (selAll.all(profile) as unknown as RawPerson[]).map(hydrate);
    },
    get(profile, userId) {
      const r = sel.get(profile, userId) as unknown as RawPerson | undefined;
      return r ? hydrate(r) : undefined;
    },
    set(row, now = Date.now()) {
      up.run(row.profile, row.userId, row.name, row.role, row.updatedBy, now);
      return dao.get(row.profile, row.userId)!;
    },
    remove(profile, userId) {
      return Number(del.run(profile, userId).changes) > 0;
    },
    rename(profile, userId, name) {
      ren.run(name, profile, userId, name);
    },
  };
  return dao;
}

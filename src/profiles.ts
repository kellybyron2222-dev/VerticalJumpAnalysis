import { BASELINE_STORAGE_KEY } from "./baseline.ts";
import { BOX_HEIGHT_PREF_KEY } from "./boxHeightPref.ts";
import { ACTIVE_BOX_TEST_KEY, WORKING_BOX_STORAGE_KEY } from "./boxTest.ts";
import { CHART_MODE_PREF_KEY } from "./chartModePref.ts";
import { GITHUB_SYNC_META_KEY, GITHUB_TOKEN_KEY } from "./githubSync.ts";
import { JUMP_COUNT_PREF_KEY } from "./jumpCountPref.ts";
import { JUMP_TYPE_PREF_KEY } from "./jumpTypePref.ts";
import { GCT_TARGET_STORAGE_KEY } from "./raiseBox.ts";
import { STORAGE_KEY, type KeyValueStore } from "./storage.ts";

export const PROFILES_KEY = "jumpLab.profiles.v1";
export const ACTIVE_PROFILE_KEY = "jumpLab.activeProfileId.v1";
/** Global last “logged in” timestamp (ms). Not namespaced — gates the app open. */
export const LAST_LOGIN_AT_KEY = "jumpLab.lastProfileLoginAt.v1";
/** Re-prompt for a profile after this idle time (shared phone). */
export const STALE_LOGIN_MS = 12 * 60 * 60 * 1000;
export const BYRON_PROFILE_ID = "byron";
export const DEFAULT_BYRON_NAME = "Byron";
export const VISITED_KEY = "jumpLab.visited.v1";

/** Logical keys stored per profile (namespaced under the active profile). */
export const PROFILE_SCOPED_KEYS = [
  STORAGE_KEY,
  BOX_HEIGHT_PREF_KEY,
  JUMP_TYPE_PREF_KEY,
  JUMP_COUNT_PREF_KEY,
  CHART_MODE_PREF_KEY,
  WORKING_BOX_STORAGE_KEY,
  ACTIVE_BOX_TEST_KEY,
  BASELINE_STORAGE_KEY,
  GCT_TARGET_STORAGE_KEY,
  GITHUB_TOKEN_KEY,
  GITHUB_SYNC_META_KEY,
  VISITED_KEY,
] as const;

export interface Profile {
  id: string;
  name: string;
  /** Only the migrated Byron profile may use GitHub sync / token. */
  allowGithub: boolean;
  createdAt: string;
  /** Small JPEG/PNG data URL for the circle avatar (optional). */
  avatarDataUrl?: string | null;
}

export const AVATAR_EDGE_PX = 128;
export const AVATAR_MAX_DATA_URL_CHARS = 80_000;

export interface ProfilesState {
  profiles: Profile[];
  activeId: string;
}

export function scopedKey(profileId: string, logicalKey: string): string {
  if (!logicalKey.startsWith("jumpLab.")) return `jumpLab.p.${profileId}.${logicalKey}`;
  return `jumpLab.p.${profileId}.${logicalKey.slice("jumpLab.".length)}`;
}

/** KeyValueStore that remaps every jumpLab.* key into the active profile namespace. */
export function createProfileStore(root: KeyValueStore, profileId: string): KeyValueStore {
  return {
    getItem(key: string): string | null {
      return root.getItem(scopedKey(profileId, key));
    },
    setItem(key: string, value: string): void {
      root.setItem(scopedKey(profileId, key), value);
    },
  };
}

export function newProfileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function readProfilesRaw(root: KeyValueStore): Profile[] {
  try {
    const raw = root.getItem(PROFILES_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .filter((p): p is Profile => {
        if (!p || typeof p !== "object") return false;
        const o = p as Record<string, unknown>;
        return (
          typeof o.id === "string" &&
          o.id.length > 0 &&
          typeof o.name === "string" &&
          o.name.trim().length > 0 &&
          typeof o.allowGithub === "boolean" &&
          typeof o.createdAt === "string"
        );
      })
      .map((p) => {
        const o = p as Profile & { avatarDataUrl?: unknown };
        const avatar =
          typeof o.avatarDataUrl === "string" && o.avatarDataUrl.startsWith("data:image/")
            ? o.avatarDataUrl
            : null;
        return {
          id: o.id,
          name: o.name.trim(),
          allowGithub: o.allowGithub,
          createdAt: o.createdAt,
          avatarDataUrl: avatar,
        };
      });
  } catch {
    return [];
  }
}

function writeProfiles(root: KeyValueStore, profiles: readonly Profile[]): void {
  root.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export function loadProfiles(root: KeyValueStore): Profile[] {
  return readProfilesRaw(root);
}

export function loadActiveProfileId(root: KeyValueStore): string | null {
  try {
    const id = root.getItem(ACTIVE_PROFILE_KEY);
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function saveActiveProfileId(root: KeyValueStore, id: string): void {
  root.setItem(ACTIVE_PROFILE_KEY, id);
}

export function recordProfileLogin(root: KeyValueStore, nowMs = Date.now()): void {
  try {
    root.setItem(LAST_LOGIN_AT_KEY, String(nowMs));
  } catch {
    /* ignore */
  }
}

export function loadLastLoginAt(root: KeyValueStore): number | null {
  try {
    const raw = root.getItem(LAST_LOGIN_AT_KEY);
    if (raw === null || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Open on the Profiles screen when there are no profiles yet, never logged in,
 * or the last login is older than STALE_LOGIN_MS.
 */
export function shouldOpenOnProfiles(
  root: KeyValueStore,
  nowMs = Date.now(),
  staleMs = STALE_LOGIN_MS,
): boolean {
  if (loadProfiles(root).length === 0) return true;
  const last = loadLastLoginAt(root);
  if (last === null) return true;
  return nowMs - last >= staleMs;
}

export function getActiveProfile(root: KeyValueStore): Profile | null {
  const profiles = loadProfiles(root);
  const activeId = loadActiveProfileId(root);
  if (!activeId) return profiles[0] ?? null;
  return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
}

/** True when unscoped legacy keys still hold data (pre-profile install). */
export function hasLegacyProfileData(root: KeyValueStore): boolean {
  for (const key of PROFILE_SCOPED_KEYS) {
    try {
      const v = root.getItem(key);
      if (v !== null && v !== "") return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function copyLogicalKey(
  root: KeyValueStore,
  fromProfileId: string | null,
  toProfileId: string,
  logicalKey: string,
): void {
  const fromKey = fromProfileId === null ? logicalKey : scopedKey(fromProfileId, logicalKey);
  const toKey = scopedKey(toProfileId, logicalKey);
  try {
    const value = root.getItem(fromKey);
    if (value === null) return;
    root.setItem(toKey, value);
  } catch {
    /* ignore */
  }
}

export function clearLogicalKey(
  root: KeyValueStore,
  profileId: string | null,
  logicalKey: string,
): void {
  const key = profileId === null ? logicalKey : scopedKey(profileId, logicalKey);
  try {
    root.setItem(key, "");
    // Prefer removeItem when available (Storage).
    const removable = root as KeyValueStore & { removeItem?: (k: string) => void };
    removable.removeItem?.(key);
  } catch {
    /* ignore */
  }
}

export function wipeProfileData(root: KeyValueStore, profileId: string): void {
  for (const key of PROFILE_SCOPED_KEYS) {
    clearLogicalKey(root, profileId, key);
  }
  // Also clear any other jumpLab.p.{id}.* keys if Storage enumerates.
  const storage = root as KeyValueStore & { length?: number; key?: (i: number) => string | null };
  if (typeof storage.length === "number" && typeof storage.key === "function") {
    const prefix = `jumpLab.p.${profileId}.`;
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    for (const k of toRemove) {
      try {
        (root as KeyValueStore & { removeItem?: (x: string) => void }).removeItem?.(k);
        root.setItem(k, "");
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Migrate pre-profile localStorage into profile `byron` named Byron.
 * Idempotent: safe to call on every boot.
 */
export function migrateLegacyToByron(root: KeyValueStore): Profile {
  let profiles = loadProfiles(root);
  let byron = profiles.find((p) => p.id === BYRON_PROFILE_ID);
  if (!byron) {
    byron = {
      id: BYRON_PROFILE_ID,
      name: DEFAULT_BYRON_NAME,
      allowGithub: true,
      createdAt: new Date().toISOString(),
    };
    profiles = [...profiles, byron];
    writeProfiles(root, profiles);
  } else if (!byron.allowGithub) {
    byron = { ...byron, allowGithub: true };
    profiles = profiles.map((p) => (p.id === BYRON_PROFILE_ID ? byron! : p));
    writeProfiles(root, profiles);
  }

  if (hasLegacyProfileData(root)) {
    for (const key of PROFILE_SCOPED_KEYS) {
      const legacy = root.getItem(key);
      if (legacy === null || legacy === "") continue;
      const scoped = scopedKey(BYRON_PROFILE_ID, key);
      const existing = root.getItem(scoped);
      // Do not overwrite already-migrated Byron data with empty/stale leftovers.
      if (existing === null || existing === "") {
        root.setItem(scoped, legacy);
      }
      clearLogicalKey(root, null, key);
    }
  }

  if (!loadActiveProfileId(root)) {
    saveActiveProfileId(root, BYRON_PROFILE_ID);
  }
  return byron;
}

export function createProfile(
  root: KeyValueStore,
  name: string,
  options: { allowGithub?: boolean; id?: string } = {},
): Profile {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Profile name is required.");
  const profiles = loadProfiles(root);
  if (profiles.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error("A profile with that name already exists.");
  }
  const profile: Profile = {
    id: options.id ?? newProfileId(),
    name: trimmed,
    allowGithub: options.allowGithub === true,
    createdAt: new Date().toISOString(),
  };
  writeProfiles(root, [...profiles, profile]);
  saveActiveProfileId(root, profile.id);
  return profile;
}

export function renameProfile(root: KeyValueStore, id: string, name: string): Profile {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Profile name is required.");
  const profiles = loadProfiles(root);
  if (profiles.some((p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error("A profile with that name already exists.");
  }
  const next = profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
  const found = next.find((p) => p.id === id);
  if (!found) throw new Error("Profile not found.");
  writeProfiles(root, next);
  return found;
}

export function setProfileAvatar(
  root: KeyValueStore,
  id: string,
  avatarDataUrl: string | null,
): Profile {
  if (
    avatarDataUrl !== null &&
    (!avatarDataUrl.startsWith("data:image/") || avatarDataUrl.length > AVATAR_MAX_DATA_URL_CHARS)
  ) {
    throw new Error("Photo is too large or not a valid image. Try a smaller picture.");
  }
  const profiles = loadProfiles(root);
  const next = profiles.map((p) =>
    p.id === id ? { ...p, avatarDataUrl: avatarDataUrl || null } : p,
  );
  const found = next.find((p) => p.id === id);
  if (!found) throw new Error("Profile not found.");
  writeProfiles(root, next);
  return found;
}

/** First letter(s) for the empty circle placeholder. */
export function profileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase();
}

/**
 * Center-crop and resize to a square JPEG data URL for the avatar circle.
 * Keeps localStorage small.
 */
export async function imageFileToAvatarDataUrl(
  file: Blob,
  edgePx = AVATAR_EDGE_PX,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose a photo (JPEG or PNG).");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const size = Math.min(bitmap.width, bitmap.height);
    const sx = Math.floor((bitmap.width - size) / 2);
    const sy = Math.floor((bitmap.height - size) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = edgePx;
    canvas.height = edgePx;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process the photo.");
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, edgePx, edgePx);
    let quality = 0.82;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > AVATAR_MAX_DATA_URL_CHARS && quality > 0.45) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrl.length > AVATAR_MAX_DATA_URL_CHARS) {
      throw new Error("Photo is still too large after resize. Try another picture.");
    }
    return dataUrl;
  } finally {
    bitmap.close();
  }
}

export function switchProfile(root: KeyValueStore, id: string): Profile {
  const profiles = loadProfiles(root);
  const found = profiles.find((p) => p.id === id);
  if (!found) throw new Error("Profile not found.");
  saveActiveProfileId(root, id);
  return found;
}

/**
 * Delete a profile and wipe its namespaced data. Cannot delete the last profile.
 * If deleting the active profile, switches to another (prefers Byron).
 */
export function deleteProfile(root: KeyValueStore, id: string): ProfilesState {
  const profiles = loadProfiles(root);
  if (profiles.length <= 1) throw new Error("Cannot delete the only profile.");
  if (!profiles.some((p) => p.id === id)) throw new Error("Profile not found.");
  wipeProfileData(root, id);
  const next = profiles.filter((p) => p.id !== id);
  writeProfiles(root, next);
  let activeId = loadActiveProfileId(root);
  if (activeId === id || !next.some((p) => p.id === activeId)) {
    activeId = next.find((p) => p.id === BYRON_PROFILE_ID)?.id ?? next[0]!.id;
    saveActiveProfileId(root, activeId);
  }
  return { profiles: next, activeId: activeId! };
}

export interface BootProfilesResult {
  profiles: Profile[];
  active: Profile | null;
  store: KeyValueStore | null;
  /** True when the user must create a first profile (empty device). */
  needsCreatePrompt: boolean;
  migrated: boolean;
}

/**
 * Boot profiles: migrate legacy → Byron when needed; otherwise prompt to create.
 */
export function bootProfiles(root: KeyValueStore): BootProfilesResult {
  const existing = loadProfiles(root);
  const legacy = hasLegacyProfileData(root);

  if (existing.length === 0 && legacy) {
    const byron = migrateLegacyToByron(root);
    return {
      profiles: loadProfiles(root),
      active: byron,
      store: createProfileStore(root, byron.id),
      needsCreatePrompt: false,
      migrated: true,
    };
  }

  if (existing.length === 0 && !legacy) {
    return {
      profiles: [],
      active: null,
      store: null,
      needsCreatePrompt: true,
      migrated: false,
    };
  }

  // Profiles already exist — still drain any leftover legacy into Byron if present.
  let migrated = false;
  if (legacy) {
    migrateLegacyToByron(root);
    migrated = true;
  }
  const active = getActiveProfile(root);
  if (!active) {
    return {
      profiles: loadProfiles(root),
      active: null,
      store: null,
      needsCreatePrompt: true,
      migrated,
    };
  }
  if (!loadActiveProfileId(root)) saveActiveProfileId(root, active.id);
  return {
    profiles: loadProfiles(root),
    active,
    store: createProfileStore(root, active.id),
    needsCreatePrompt: false,
    migrated,
  };
}

/** Second profile must not see Byron's scoped keys (for tests + safety checks). */
export function profileReadsKey(
  root: KeyValueStore,
  profileId: string,
  logicalKey: string,
): string | null {
  return createProfileStore(root, profileId).getItem(logicalKey);
}

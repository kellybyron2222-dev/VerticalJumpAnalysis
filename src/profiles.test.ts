import { describe, expect, it } from "vitest";
import { GITHUB_TOKEN_KEY } from "./githubSync.ts";
import {
  BYRON_PROFILE_ID,
  STALE_LOGIN_MS,
  bootProfiles,
  createProfile,
  createProfileStore,
  deleteProfile,
  hasLegacyProfileData,
  loadProfiles,
  migrateLegacyToByron,
  profileInitials,
  profileReadsKey,
  recordProfileLogin,
  renameProfile,
  scopedKey,
  setProfileAvatar,
  shouldOpenOnProfiles,
  switchProfile,
} from "./profiles.ts";
import { STORAGE_KEY } from "./storage.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
    get length() {
      return Object.keys(data).length;
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
  };
}

const sampleTrials = JSON.stringify([
  {
    id: "t1",
    createdAt: "2026-10-14T15:00:00",
    fps: 170,
    jumpType: "drop",
    boxHeightIn: 6,
    armSwing: false,
    notes: "byron only",
    touchdownFrame: 1,
    takeoffFrame: 2,
    landingFrame: 3,
    gctMs: 200,
    flightMs: 500,
    heightM: 0.3,
    heightIn: 12,
    heightCm: 30,
    rsi: 1.5,
  },
]);

describe("profile namespacing", () => {
  it("scopes logical keys per profile id", () => {
    expect(scopedKey("byron", STORAGE_KEY)).toBe("jumpLab.p.byron.trials.v1");
    expect(scopedKey("friend", GITHUB_TOKEN_KEY)).toBe("jumpLab.p.friend.githubToken.v1");
  });

  it("profile stores do not share trials", () => {
    const root = memoryStore();
    const byron = createProfileStore(root, "byron");
    const friend = createProfileStore(root, "friend");
    byron.setItem(STORAGE_KEY, sampleTrials);
    friend.setItem(STORAGE_KEY, "[]");
    expect(byron.getItem(STORAGE_KEY)).toBe(sampleTrials);
    expect(friend.getItem(STORAGE_KEY)).toBe("[]");
    expect(root.getItem(scopedKey("byron", STORAGE_KEY))).toBe(sampleTrials);
  });
});

describe("legacy migration to Byron", () => {
  it("moves existing data into Byron without loss and enables GitHub on that profile only", () => {
    const root = memoryStore({
      [STORAGE_KEY]: sampleTrials,
      [GITHUB_TOKEN_KEY]: "ghp_secret_byron",
    });
    expect(hasLegacyProfileData(root)).toBe(true);
    const byron = migrateLegacyToByron(root);
    expect(byron.id).toBe(BYRON_PROFILE_ID);
    expect(byron.name).toBe("Byron");
    expect(byron.allowGithub).toBe(true);

    const store = createProfileStore(root, BYRON_PROFILE_ID);
    expect(store.getItem(STORAGE_KEY)).toBe(sampleTrials);
    expect(store.getItem(GITHUB_TOKEN_KEY)).toBe("ghp_secret_byron");
    // Legacy unscoped keys cleared.
    expect(root.getItem(STORAGE_KEY)).toBeNull();
    expect(root.getItem(GITHUB_TOKEN_KEY)).toBeNull();

    const boot = bootProfiles(root);
    expect(boot.migrated).toBe(false); // already migrated
    expect(boot.active?.id).toBe(BYRON_PROFILE_ID);
    expect(boot.store?.getItem(STORAGE_KEY)).toBe(sampleTrials);
  });

  it("boot migrates once from legacy on empty profiles list", () => {
    const root = memoryStore({ [STORAGE_KEY]: sampleTrials });
    const boot = bootProfiles(root);
    expect(boot.needsCreatePrompt).toBe(false);
    expect(boot.migrated).toBe(true);
    expect(boot.active?.name).toBe("Byron");
    expect(boot.store?.getItem(STORAGE_KEY)).toBe(sampleTrials);
  });
});

describe("second profile isolation", () => {
  it("never reads or writes Byron trials or GitHub token", () => {
    const root = memoryStore();
    migrateLegacyToByron(root);
    const byronStore = createProfileStore(root, BYRON_PROFILE_ID);
    byronStore.setItem(STORAGE_KEY, sampleTrials);
    byronStore.setItem(GITHUB_TOKEN_KEY, "ghp_byron_only");

    const friend = createProfile(root, "Friend", { allowGithub: false });
    expect(friend.allowGithub).toBe(false);
    expect(friend.id).not.toBe(BYRON_PROFILE_ID);

    const friendStore = createProfileStore(root, friend.id);
    expect(friendStore.getItem(STORAGE_KEY)).toBeNull();
    expect(friendStore.getItem(GITHUB_TOKEN_KEY)).toBeNull();
    expect(profileReadsKey(root, friend.id, STORAGE_KEY)).toBeNull();
    expect(profileReadsKey(root, friend.id, GITHUB_TOKEN_KEY)).toBeNull();

    friendStore.setItem(STORAGE_KEY, JSON.stringify([{ id: "friend-jump" }]));
    friendStore.setItem(GITHUB_TOKEN_KEY, "should_not_matter");
    // Byron untouched.
    expect(byronStore.getItem(STORAGE_KEY)).toBe(sampleTrials);
    expect(byronStore.getItem(GITHUB_TOKEN_KEY)).toBe("ghp_byron_only");
    expect(root.getItem(scopedKey(BYRON_PROFILE_ID, GITHUB_TOKEN_KEY))).toBe("ghp_byron_only");
  });

  it("switch / rename / delete keep Byron data intact", () => {
    const root = memoryStore({ [STORAGE_KEY]: sampleTrials, [GITHUB_TOKEN_KEY]: "tok" });
    migrateLegacyToByron(root);
    createProfile(root, "Pal");
    switchProfile(root, BYRON_PROFILE_ID);
    renameProfile(root, BYRON_PROFILE_ID, "Byron K");
    expect(loadProfiles(root).find((p) => p.id === BYRON_PROFILE_ID)?.name).toBe("Byron K");
    const pal = loadProfiles(root).find((p) => p.name === "Pal")!;
    deleteProfile(root, pal.id);
    expect(createProfileStore(root, BYRON_PROFILE_ID).getItem(STORAGE_KEY)).toBe(sampleTrials);
    expect(createProfileStore(root, BYRON_PROFILE_ID).getItem(GITHUB_TOKEN_KEY)).toBe("tok");
  });
});

describe("first-time empty device", () => {
  it("asks to create a profile when nothing is stored", () => {
    const boot = bootProfiles(memoryStore());
    expect(boot.needsCreatePrompt).toBe(true);
    expect(boot.store).toBeNull();
    expect(boot.profiles).toEqual([]);
  });
});

describe("profile login gate", () => {
  it("opens on Profiles for first visit and after a long idle", () => {
    const root = memoryStore();
    expect(shouldOpenOnProfiles(root)).toBe(true);
    migrateLegacyToByron(root);
    expect(shouldOpenOnProfiles(root)).toBe(true); // never logged in yet
    const t0 = 1_700_000_000_000;
    recordProfileLogin(root, t0);
    expect(shouldOpenOnProfiles(root, t0 + 60_000)).toBe(false);
    expect(shouldOpenOnProfiles(root, t0 + STALE_LOGIN_MS + 1)).toBe(true);
  });
});

describe("profile avatar", () => {
  it("stores and clears a circle photo data URL on the profile", () => {
    const root = memoryStore();
    const pal = createProfile(root, "Pal");
    expect(profileInitials("Byron Kelly")).toBe("BK");
    expect(profileInitials("sam")).toBe("S");
    const tiny = "data:image/jpeg;base64,/9j/4AAQ";
    const withPhoto = setProfileAvatar(root, pal.id, tiny);
    expect(withPhoto.avatarDataUrl).toBe(tiny);
    expect(loadProfiles(root).find((p) => p.id === pal.id)?.avatarDataUrl).toBe(tiny);
    expect(setProfileAvatar(root, pal.id, null).avatarDataUrl).toBeNull();
  });
});

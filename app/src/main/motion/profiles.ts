export const PROFILES = [
  { id: 'A-modern', legacy: false, xiaomiFlag: false },
  { id: 'B-dual', legacy: true, xiaomiFlag: false },
  { id: 'C-modern-xiaomi', legacy: false, xiaomiFlag: true },
  { id: 'D-dual-xiaomi', legacy: true, xiaomiFlag: true },
] as const;

export type MotionProfile = typeof PROFILES[number];

// Device-scoped default from M0 user-reported phone testing, not universal Android compatibility.
export const DEFAULT_PROFILE_ID = 'C-modern-xiaomi' as const;
export const VERIFIED_TARGET = Object.freeze({
  model: 'Redmi K70E',
  osBuild: '3.0.304.0.WNLCNXM.C11',
  android: '16',
  gallery: '4.3.1.18',
  fixtureRunId: '20261021124310397-6e1757',
  verification: 'user-reported recognition, playback, orientation and custom-cover retention',
});

export function getProfile(id: string): MotionProfile {
  const profile = PROFILES.find(profile => profile.id === id);
  if (!profile) throw new Error(`Unknown candidate profile: ${id}`);
  return profile;
}

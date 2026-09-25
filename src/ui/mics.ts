// The microphone list for a <select>: the audio inputs `enumerateDevices` reports, plus "No
// microphone". Labels (and device ids worth storing) exist only once the extension origin holds
// the microphone permission, which the first recording grants; before that only the default
// device can be offered.

/** The option value for "no microphone". */
export const NO_MIC = 'none';
/** The option value for the default device (no deviceId constraint). */
export const DEFAULT_MIC = '';

export interface MicChoice {
  mic: boolean;
  /** Absent: the default device. */
  micDeviceId?: string;
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audioinput' && d.label,
    );
  } catch {
    return [];
  }
}

/**
 * Fill `select` with the microphones (`given`, or this page's own) and select `current`; the
 * default device when it is gone.
 */
export async function fillMicSelect(
  select: HTMLSelectElement,
  current: MicChoice,
  given?: { deviceId: string; label: string }[],
): Promise<void> {
  const mics = given ?? (await listMics());
  select.replaceChildren();
  const add = (value: string, text: string): void => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    select.append(o);
  };
  if (mics.length === 0) add(DEFAULT_MIC, 'Default microphone');
  for (const d of mics) add(d.deviceId, d.label);
  add(NO_MIC, 'No microphone');
  const values = [...select.options].map((o) => o.value);
  const wanted = current.mic ? current.micDeviceId || DEFAULT_MIC : NO_MIC;
  select.value = values.includes(wanted)
    ? wanted
    : values.includes('default')
      ? 'default'
      : values[0]!;
}

/** The choice `select` shows. "No microphone" keeps no device id: the last one stays in Settings. */
export function micChoice(select: HTMLSelectElement): MicChoice {
  const v = select.value;
  if (v === NO_MIC) return { mic: false };
  return { mic: true, micDeviceId: v === DEFAULT_MIC ? undefined : v };
}

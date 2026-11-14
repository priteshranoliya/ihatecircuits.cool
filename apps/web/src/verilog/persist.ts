/** The editor text lives in this browser only. Every access is guarded, and the editor works without storage. */
export const TEXT_KEY = 'ihatecircuits:verilog:v1';

export function loadText(): string | null {
  try {
    return localStorage.getItem(TEXT_KEY);
  } catch {
    return null;
  }
}

export function saveText(text: string) {
  try {
    localStorage.setItem(TEXT_KEY, text);
  } catch {
    /* storage full or blocked: the text just is not remembered */
  }
}

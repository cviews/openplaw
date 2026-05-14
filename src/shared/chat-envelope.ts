export function stripEnvelope(text: string): string {
  return text.replace(/\[omo:[^\]]*\]/g, "");
}

export function stripMessageIdHints(text: string): string {
  return text.replace(/<!-- msg:[^>]* -->/g, "");
}

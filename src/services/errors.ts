// An error the caller can fix. Its message is shown to the agent or person as is.
export class PairError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Ids are shown with a prefix: m_12 (message), p_3 (pair), s_7 (session). */
export function ref(prefix: 'm' | 'p' | 's', id: number): string {
  return `${prefix}_${id}`;
}

export function parseRef(prefix: 'm' | 'p' | 's', value: string | number): number {
  const text = String(value).trim();
  const match = text.match(new RegExp(`^(?:${prefix}_)?(\\d+)$`));
  if (!match) throw new PairError(`"${text}" is not a valid id; expected ${prefix}_<number>`);
  return Number(match[1]);
}

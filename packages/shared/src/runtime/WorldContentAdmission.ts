/**
 * Per-transport world admission. Authentication opens a transport, not a world:
 * only an exact, locally computed content identity admits world packets.
 */
export class WorldContentAdmission {
  private state: "closed" | "pending" | "admitted" | "rejected" = "closed";
  private generation = 0;
  private rejectionReason: string | null = null;
  private validatedIdentity: string | null = null;

  constructor(private readonly readLocalIdentity: () => string) {}

  beginConnection(): void {
    this.generation++;
    this.state = "pending";
    this.validatedIdentity = null;
    // Keep the last failure visible until a new connection actually validates.
  }

  get admitted(): boolean {
    return this.state === "admitted";
  }

  get admittedIdentity(): string | null {
    return this.admitted ? this.validatedIdentity : null;
  }

  get rejected(): boolean {
    return this.state === "rejected";
  }

  get failure(): string | null {
    return this.rejectionReason;
  }

  /** Returns a generation token for cancelling delayed snapshot work. */
  admitSnapshot(remoteIdentity: unknown): number | null {
    if (this.state === "rejected" || this.state === "closed") return null;

    let localIdentity: string;
    try {
      localIdentity = this.readLocalIdentity();
    } catch {
      this.reject(
        "Local world content is not ready. Reload after updating assets.",
      );
      return null;
    }

    const validIdentity = (value: unknown): value is string =>
      typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    if (!validIdentity(localIdentity) || !validIdentity(remoteIdentity)) {
      this.reject(
        "World content identity is missing or invalid. Update both client and server.",
      );
      return null;
    }
    if (remoteIdentity !== localIdentity) {
      this.reject(
        "Client and server world content differs. Update assets and reload.",
      );
      return null;
    }

    this.state = "admitted";
    this.validatedIdentity = remoteIdentity;
    this.rejectionReason = null;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.admitted && generation === this.generation;
  }

  allowsPacket(method: string): boolean {
    if (this.admitted) return true;
    return (
      this.state === "pending" &&
      (method === "snapshot" ||
        method === "onSnapshot" ||
        method === "authResult" ||
        method === "onAuthResult")
    );
  }

  reject(reason: string): void {
    if (this.state === "rejected") return;
    this.rejectionReason = reason;
    this.state = "rejected";
    this.validatedIdentity = null;
  }

  close(): void {
    this.validatedIdentity = null;
    // A close must not erase a rejection or permit a late packet to recover it.
    if (this.state !== "rejected") this.state = "closed";
  }
}

/**
 * The domain event bus.
 *
 * Publishing is fire-and-forget from the caller's point of view, but events are
 * written to an outbox in the same transaction as the state change they
 * describe and relayed from there. That is what stops the classic marketplace
 * bug where a gig goes live and nobody is notified because the broker was
 * briefly unreachable.
 *
 * Topics are the Kafka topics in the architecture diagram; the in-memory bus
 * below implements the same contract for tests and local runs.
 */
export const TOPICS = {
  gigStateChanged: "gig.state.changed",
  gigPosted: "gig.posted",
  applicationReceived: "gig.application.received",
  offerExtended: "gig.offer.extended",
  matchWaveScheduled: "match.wave.scheduled",
  escrowFunded: "ledger.escrow.funded",
  escrowReleased: "ledger.escrow.released",
  escrowRefunded: "ledger.escrow.refunded",
  disputeOpened: "ledger.dispute.opened",
  userVerified: "identity.user.verified",
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export interface DomainEvent<T = unknown> {
  readonly id: string;
  readonly topic: Topic;
  /** Partition key: everything about one gig stays in order. */
  readonly key: string;
  readonly payload: T;
  readonly occurredAt: string;
  /** Carried end to end so a notification can be traced back to its cause. */
  readonly traceId?: string;
}

export type Handler = (event: DomainEvent) => void | Promise<void>;

export interface EventBus {
  publish<T>(topic: Topic, key: string, payload: T, traceId?: string): Promise<DomainEvent<T>>;
  subscribe(topic: Topic, handler: Handler): () => void;
}

export class InMemoryEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  private readonly handlers = new Map<Topic, Set<Handler>>();
  private sequence = 0;

  async publish<T>(topic: Topic, key: string, payload: T, traceId?: string): Promise<DomainEvent<T>> {
    this.sequence += 1;
    const event: DomainEvent<T> = {
      id: `evt_${this.sequence}`,
      topic,
      key,
      payload,
      occurredAt: new Date().toISOString(),
      ...(traceId ? { traceId } : {}),
    };
    this.published.push(event as DomainEvent);
    for (const handler of this.handlers.get(topic) ?? []) {
      // A failing subscriber must not fail the publisher; the relay retries.
      try {
        await handler(event as DomainEvent);
      } catch (error) {
        console.error(`subscriber for ${topic} threw`, error);
      }
    }
    return event;
  }

  subscribe(topic: Topic, handler: Handler): () => void {
    const set = this.handlers.get(topic) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(topic, set);
    return () => set.delete(handler);
  }

  eventsFor(topic: Topic): DomainEvent[] {
    return this.published.filter((event) => event.topic === topic);
  }
}

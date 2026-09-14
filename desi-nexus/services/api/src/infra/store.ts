/**
 * The repository layer.
 *
 * Interfaces first, in-memory implementations behind them. The PostgreSQL
 * implementations land against the schema in db/migrations/001_init.sql without
 * the domain or the routes changing, because nothing above this line knows what
 * a row is.
 */
import type { BaseUser, CrewProfile, CreatorProfile, HostProfile } from "../domain/users.js";
import type { Gig } from "../domain/gig.js";
import type { Escrow } from "../domain/escrow.js";
import type { Cents } from "../domain/money.js";

export interface Application {
  readonly id: string;
  readonly gigId: string;
  readonly vendorId: string;
  quotedRateCents: Cents;
  message?: string;
  status: "submitted" | "shortlisted" | "offered" | "accepted" | "declined" | "withdrawn";
  readonly createdAt: string;
}

export interface Credentials {
  readonly userId: string;
  passwordHash: string;
  mfaSecret?: string;
  otpHash?: string;
  otpExpiresAt?: string;
  failedAttempts: number;
  lockedUntil?: string;
}

export interface UserRepository {
  create(user: BaseUser): Promise<BaseUser>;
  byId(id: string): Promise<BaseUser | undefined>;
  byEmail(email: string): Promise<BaseUser | undefined>;
  update(id: string, patch: Partial<BaseUser>): Promise<BaseUser>;
}

export interface ProfileRepository {
  putHost(profile: HostProfile): Promise<HostProfile>;
  putCrew(profile: CrewProfile): Promise<CrewProfile>;
  putCreator(profile: CreatorProfile): Promise<CreatorProfile>;
  host(userId: string): Promise<HostProfile | undefined>;
  crew(userId: string): Promise<CrewProfile | undefined>;
  creator(userId: string): Promise<CreatorProfile | undefined>;
  /** Candidate pool for matching, pre-filtered on speciality. */
  crewBySpecialty(specialty: string): Promise<CrewProfile[]>;
}

export interface GigRepository {
  create(gig: Gig): Promise<Gig>;
  byId(id: string): Promise<Gig | undefined>;
  byHost(hostId: string): Promise<Gig[]>;
  /**
   * Gigs still taking applications, optionally narrowed to a set of
   * specialities. Backed by the partial index on (specialty_code, event_date),
   * so this stays an index lookup rather than a scan of every gig ever posted.
   */
  open(specialties?: readonly string[]): Promise<Gig[]>;
  save(gig: Gig): Promise<Gig>;
}

export interface ApplicationRepository {
  create(application: Application): Promise<Application>;
  byId(id: string): Promise<Application | undefined>;
  byGig(gigId: string): Promise<Application[]>;
  save(application: Application): Promise<Application>;
}

export interface EscrowRepository {
  create(escrow: Escrow): Promise<Escrow>;
  byId(id: string): Promise<Escrow | undefined>;
  byGig(gigId: string): Promise<Escrow | undefined>;
  save(escrow: Escrow): Promise<Escrow>;
}

export interface CredentialRepository {
  put(credentials: Credentials): Promise<Credentials>;
  byUserId(userId: string): Promise<Credentials | undefined>;
}

/** Everything the service needs to reach persistence. */
export interface Store {
  readonly users: UserRepository;
  readonly profiles: ProfileRepository;
  readonly gigs: GigRepository;
  readonly applications: ApplicationRepository;
  readonly escrows: EscrowRepository;
  readonly credentials: CredentialRepository;
}

/**
 * Deep-copy on the way in and out, so a caller mutating what it read cannot
 * silently corrupt stored state. Postgres gives this for free; the in-memory
 * store has to be explicit or the tests pass for the wrong reason.
 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryUsers implements UserRepository {
  private readonly byIdMap = new Map<string, BaseUser>();
  private readonly byEmailMap = new Map<string, string>();
  private readonly byPhoneMap = new Map<string, string>();

  async create(user: BaseUser): Promise<BaseUser> {
    const key = user.email.toLowerCase();
    if (this.byEmailMap.has(key)) throw new Error("email already registered");
    // Phone is unique in the schema, and must be here too: a number shared
    // between accounts means an OTP that authenticates the wrong person.
    if (user.phone && this.byPhoneMap.has(user.phone)) {
      throw new Error("phone already registered");
    }
    this.byIdMap.set(user.id, clone(user));
    this.byEmailMap.set(key, user.id);
    if (user.phone) this.byPhoneMap.set(user.phone, user.id);
    return clone(user);
  }

  async byId(id: string): Promise<BaseUser | undefined> {
    const user = this.byIdMap.get(id);
    return user ? clone(user) : undefined;
  }

  async byEmail(email: string): Promise<BaseUser | undefined> {
    const id = this.byEmailMap.get(email.toLowerCase());
    return id ? this.byId(id) : undefined;
  }

  async update(id: string, patch: Partial<BaseUser>): Promise<BaseUser> {
    const user = this.byIdMap.get(id);
    if (!user) throw new Error(`no such user: ${id}`);
    if (patch.phone && patch.phone !== user.phone && this.byPhoneMap.has(patch.phone)) {
      throw new Error("phone already registered");
    }
    const updated = { ...user, ...patch, id: user.id } as BaseUser;
    this.byIdMap.set(id, updated);
    if (user.phone && updated.phone !== user.phone) this.byPhoneMap.delete(user.phone);
    if (updated.phone) this.byPhoneMap.set(updated.phone, id);
    return clone(updated);
  }
}

class MemoryProfiles implements ProfileRepository {
  private readonly hosts = new Map<string, HostProfile>();
  private readonly crewMap = new Map<string, CrewProfile>();
  private readonly creators = new Map<string, CreatorProfile>();

  async putHost(profile: HostProfile): Promise<HostProfile> {
    this.hosts.set(profile.userId, clone(profile));
    return clone(profile);
  }

  async putCrew(profile: CrewProfile): Promise<CrewProfile> {
    this.crewMap.set(profile.userId, clone(profile));
    return clone(profile);
  }

  async putCreator(profile: CreatorProfile): Promise<CreatorProfile> {
    this.creators.set(profile.userId, clone(profile));
    return clone(profile);
  }

  async host(userId: string): Promise<HostProfile | undefined> {
    const profile = this.hosts.get(userId);
    return profile ? clone(profile) : undefined;
  }

  async crew(userId: string): Promise<CrewProfile | undefined> {
    const profile = this.crewMap.get(userId);
    return profile ? clone(profile) : undefined;
  }

  async creator(userId: string): Promise<CreatorProfile | undefined> {
    const profile = this.creators.get(userId);
    return profile ? clone(profile) : undefined;
  }

  async crewBySpecialty(specialty: string): Promise<CrewProfile[]> {
    return [...this.crewMap.values()]
      .filter((profile) => (profile.specialties as readonly string[]).includes(specialty))
      .map(clone);
  }
}

class MemoryGigs implements GigRepository {
  private readonly map = new Map<string, Gig>();

  async create(gig: Gig): Promise<Gig> {
    this.map.set(gig.id, clone(gig));
    return clone(gig);
  }

  async byId(id: string): Promise<Gig | undefined> {
    const gig = this.map.get(id);
    return gig ? clone(gig) : undefined;
  }

  async byHost(hostId: string): Promise<Gig[]> {
    return [...this.map.values()].filter((gig) => gig.hostId === hostId).map(clone);
  }

  async open(specialties?: readonly string[]): Promise<Gig[]> {
    return [...this.map.values()]
      .filter((gig) => gig.state === "Open" || gig.state === "ApplicationsReview")
      .filter((gig) => !specialties?.length || specialties.includes(gig.brief.specialty))
      .sort((a, b) => a.brief.eventDate.localeCompare(b.brief.eventDate))
      .map(clone);
  }

  async save(gig: Gig): Promise<Gig> {
    this.map.set(gig.id, clone(gig));
    return clone(gig);
  }
}

class MemoryApplications implements ApplicationRepository {
  private readonly map = new Map<string, Application>();

  async create(application: Application): Promise<Application> {
    this.map.set(application.id, clone(application));
    return clone(application);
  }

  async byId(id: string): Promise<Application | undefined> {
    const application = this.map.get(id);
    return application ? clone(application) : undefined;
  }

  async byGig(gigId: string): Promise<Application[]> {
    return [...this.map.values()].filter((application) => application.gigId === gigId).map(clone);
  }

  async save(application: Application): Promise<Application> {
    this.map.set(application.id, clone(application));
    return clone(application);
  }
}

class MemoryEscrows implements EscrowRepository {
  private readonly map = new Map<string, Escrow>();

  async create(escrow: Escrow): Promise<Escrow> {
    this.map.set(escrow.id, clone(escrow));
    return clone(escrow);
  }

  async byId(id: string): Promise<Escrow | undefined> {
    const escrow = this.map.get(id);
    return escrow ? clone(escrow) : undefined;
  }

  async byGig(gigId: string): Promise<Escrow | undefined> {
    const escrow = [...this.map.values()].find((candidate) => candidate.gigId === gigId);
    return escrow ? clone(escrow) : undefined;
  }

  async save(escrow: Escrow): Promise<Escrow> {
    this.map.set(escrow.id, clone(escrow));
    return clone(escrow);
  }
}

class MemoryCredentials implements CredentialRepository {
  private readonly map = new Map<string, Credentials>();

  async put(credentials: Credentials): Promise<Credentials> {
    this.map.set(credentials.userId, clone(credentials));
    return clone(credentials);
  }

  async byUserId(userId: string): Promise<Credentials | undefined> {
    const credentials = this.map.get(userId);
    return credentials ? clone(credentials) : undefined;
  }
}

export function createInMemoryStore(): Store {
  return {
    users: new MemoryUsers(),
    profiles: new MemoryProfiles(),
    gigs: new MemoryGigs(),
    applications: new MemoryApplications(),
    escrows: new MemoryEscrows(),
    credentials: new MemoryCredentials(),
  };
}

/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Audit T11: figures and states that were quietly wrong. Each block names the
 * finding it proves.
 */

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
    }) => {
      const identity = await ctx.auth.getUserIdentity();
      return identity ? { _id: identity.subject } : null;
    },
    getAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
    }) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthenticated");
      return { _id: identity.subject };
    },
    registerRoutes: () => {},
  },
  createAuth: () => ({}),
}));

vi.mock("./email", () => ({
  RESEND_FROM: "interw <no-reply@example.test>",
  resend: { sendEmail: () => Promise.resolve("provider-id-stub") },
}));

const modules = import.meta.glob("./**/*.ts");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function newTest() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof newTest>;

type Fixture = {
  orgId: Id<"organizations">;
  projectId: Id<"projects">;
  userId: Id<"users">;
};

const projectFields = (
  orgId: Id<"organizations">,
  userId: Id<"users">,
  slug: string,
): Omit<Doc<"projects">, "_id" | "_creationTime"> => ({
  orgId,
  slug,
  title: slug,
  status: "active",
  language: "en",
  introMode: "none",
  maxDurationMinutes: 20,
  candidateFields: {
    phone: { enabled: false, required: false },
    linkedin: { enabled: false, required: false },
    cv: { enabled: false, required: false },
    coverLetter: { enabled: false, required: false },
  },
  createdBy: userId,
  createdAt: 0,
  sessionCount: 0,
  completedSessionCount: 0,
});

async function seed(t: T): Promise<Fixture> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      betterAuthId: "ba_owner",
      email: "owner@acme.test",
      superAdmin: true,
      createdAt: 0,
    });
    const orgId = await ctx.db.insert("organizations", {
      slug: "acme",
      name: "Acme",
      createdBy: userId,
      createdAt: 0,
    });
    await ctx.db.insert("organizationMembers", {
      orgId,
      userId,
      role: "owner",
      joinedAt: 0,
    });
    const projectId = await ctx.db.insert(
      "projects",
      projectFields(orgId, userId, "backend"),
    );
    return { orgId, projectId, userId };
  });
}

const asOwner = (t: T) => t.withIdentity({ subject: "ba_owner" });

let tokenSeq = 0;
function sessionFields(
  f: Fixture,
  overrides: Partial<Doc<"sessions">> = {},
): Omit<Doc<"sessions">, "_id" | "_creationTime"> {
  tokenSeq += 1;
  return {
    orgId: f.orgId,
    projectId: f.projectId,
    accessToken: `tok${String(tokenSeq).padStart(40, "0")}`,
    candidateName: "Alex Martin",
    candidateEmail: `alex${tokenSeq}@example.test`,
    status: "pending",
    lastQuestionIndex: 0,
    invitedBy: f.userId,
    invitedAt: Date.now(),
    ...overrides,
  };
}

/* ── Back M4 ─────────────────────────────────────────────────────────────── */

describe("role slugs past 200 roles (Back M4)", () => {
  let t: T;
  let f: Fixture;

  beforeEach(async () => {
    t = newTest();
    f = await seed(t);
  });

  it("redraws a slug taken by the 250th role", async () => {
    // The old guard read the first 200 roles of the org: a slug taken by any
    // later one was invisible to it, and a duplicate was inserted.
    await t.run(async (ctx) => {
      for (let i = 0; i < 248; i++) {
        await ctx.db.insert(
          "projects",
          projectFields(f.orgId, f.userId, `r-${i}`),
        );
      }
      await ctx.db.insert(
        "projects",
        projectFields(f.orgId, f.userId, "product-manager-aaaaaa"),
      );
    });

    // The first suffix drawn is the one the 250th role holds.
    vi.spyOn(crypto, "getRandomValues").mockImplementationOnce((bytes) => {
      (bytes as Uint8Array).fill(0);
      return bytes;
    });
    const { slug } = await asOwner(t).mutation(api.projects.create, {
      orgId: f.orgId,
      title: "Product Manager",
      language: "en",
    });

    expect(slug).toMatch(/^product-manager-[a-z0-9]{6}$/);
    expect(slug).not.toBe("product-manager-aaaaaa");
  });

  it("still opens a role whose slug was duplicated before the fix", async () => {
    const first = await t.run(async (ctx) => {
      const id = await ctx.db.insert(
        "projects",
        projectFields(f.orgId, f.userId, "twin"),
      );
      await ctx.db.insert("projects", projectFields(f.orgId, f.userId, "twin"));
      return id;
    });

    const view = await asOwner(t).query(api.projects.getBySlug, {
      orgId: f.orgId,
      slug: "twin",
    });
    expect(view.project._id).toBe(first);
  });
});

/* ── B6 ──────────────────────────────────────────────────────────────────── */

describe("sessions past their role deadline (B6)", () => {
  let t: T;
  let f: Fixture;

  beforeEach(async () => {
    vi.useFakeTimers();
    t = newTest();
    f = await seed(t);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function expire() {
    await t.mutation(internal.sessions.expireOverdueSessions, { cursor: null });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  async function statuses(ids: Array<Id<"sessions">>) {
    return await t.run(async (ctx) =>
      Promise.all(
        ids.map(async (id) => (await ctx.db.get("sessions", id))?.status),
      ),
    );
  }

  it("expires the open sessions of a role a day past its deadline", async () => {
    const deadline = Date.now() + HOUR_MS;
    const ids = await t.run(async (ctx) => {
      await ctx.db.patch("projects", f.projectId, { expiresAt: deadline });
      return Promise.all(
        (["pending", "in_progress", "completed", "cancelled"] as const).map(
          (status) => ctx.db.insert("sessions", sessionFields(f, { status })),
        ),
      );
    });

    // Within the grace day: a candidate may still finish what they recorded.
    vi.setSystemTime(deadline + HOUR_MS);
    await expire();
    expect(await statuses(ids)).toEqual([
      "pending",
      "in_progress",
      "completed",
      "cancelled",
    ]);

    vi.setSystemTime(deadline + DAY_MS + HOUR_MS);
    await expire();
    expect(await statuses(ids)).toEqual([
      "expired",
      "expired",
      "completed",
      "cancelled",
    ]);
  });

  it("leaves a role without a deadline alone", async () => {
    const id = await t.run(async (ctx) =>
      ctx.db.insert("sessions", sessionFields(f)),
    );
    vi.setSystemTime(Date.now() + 400 * DAY_MS);
    await expire();
    expect(await statuses([id])).toEqual(["pending"]);
  });

  it("drains more sessions than one pass writes", async () => {
    const deadline = Date.now() + HOUR_MS;
    const ids = await t.run(async (ctx) => {
      await ctx.db.patch("projects", f.projectId, { expiresAt: deadline });
      const out: Array<Id<"sessions">> = [];
      for (let i = 0; i < 230; i++) {
        out.push(await ctx.db.insert("sessions", sessionFields(f)));
      }
      return out;
    });
    vi.setSystemTime(deadline + 2 * DAY_MS);
    await expire();
    expect(new Set(await statuses(ids))).toEqual(new Set(["expired"]));
  });

  it("reads as expired to the candidate, and to the recruiter who resends", async () => {
    const deadline = Date.now() + HOUR_MS;
    const session = await t.run(async (ctx) => {
      await ctx.db.patch("projects", f.projectId, { expiresAt: deadline });
      const id = await ctx.db.insert("sessions", sessionFields(f));
      return (await ctx.db.get("sessions", id))!;
    });
    vi.setSystemTime(deadline + 2 * DAY_MS);
    await expire();
    // The deadline moved back afterwards: the link stays closed, the status
    // is the session's own now.
    await t.run(async (ctx) =>
      ctx.db.patch("projects", f.projectId, { expiresAt: undefined }),
    );

    const view = await t.query(api.candidate.landing, {
      token: session.accessToken,
      now: Date.now(),
    });
    expect(view.gate.state).toBe("expired");
    await expect(
      asOwner(t).mutation(api.sessions.resendInvitation, {
        sessionId: session._id,
      }),
    ).rejects.toThrow(/session_closed/);
  });

  /** PR #50: past the deadline, a new link was mailed already closed. */
  it("sends no invitation nor reminder once the deadline has passed", async () => {
    const deadline = Date.now() + HOUR_MS;
    const sessionId = await t.run(async (ctx) => {
      await ctx.db.patch("projects", f.projectId, { expiresAt: deadline });
      return ctx.db.insert("sessions", sessionFields(f));
    });
    const invite = () =>
      asOwner(t).mutation(api.sessions.invite, {
        projectId: f.projectId,
        candidates: [{ name: "Alex Martin", email: "alex@example.test" }],
      });
    // Inside the grace window: the session is still open, the role is not.
    vi.setSystemTime(deadline + HOUR_MS);
    await expect(invite()).rejects.toThrow(/project_expired/);
    await expect(
      asOwner(t).mutation(api.sessions.resendInvitation, { sessionId }),
    ).rejects.toThrow(/project_expired/);

    await t.run(async (ctx) =>
      ctx.db.patch("projects", f.projectId, { expiresAt: undefined }),
    );
    await expect(invite()).resolves.toMatchObject({ created: 1 });
  });

  it("sends no reminder for an archived role", async () => {
    const sessionId = await t.run(async (ctx) => {
      await ctx.db.patch("projects", f.projectId, { status: "archived" });
      return ctx.db.insert("sessions", sessionFields(f));
    });
    await expect(
      asOwner(t).mutation(api.sessions.resendInvitation, { sessionId }),
    ).rejects.toThrow(/project_archived/);
  });
});

/* ── Pipe F9 / h07 ───────────────────────────────────────────────────────── */

describe("delivery status (Pipe F9, h07)", () => {
  let t: T;
  let f: Fixture;

  beforeEach(async () => {
    t = newTest();
    f = await seed(t);
  });

  async function logged(
    sessionId?: Id<"sessions">,
    recipient = "x@example.test",
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("emailLog", {
        orgId: f.orgId,
        template: "candidate-invitation",
        recipient,
        status: "sent",
        providerId: "prov-1",
        sessionId,
        createdAt: 0,
      }),
    );
  }

  async function event(
    type:
      | "email.sent"
      | "email.delivered"
      | "email.delivery_delayed"
      | "email.bounced",
  ) {
    const data = {
      created_at: "2026-09-25T00:00:00Z",
      email_id: "prov-1",
      from: "interw <no-reply@example.test>",
      to: "x@example.test",
      subject: "Your interview",
    };
    await t.mutation(internal.emailEvents.record, {
      id: "prov-1" as never,
      event:
        type === "email.bounced"
          ? {
              type,
              created_at: data.created_at,
              data: {
                ...data,
                bounce: {
                  message: "no such user",
                  subType: "General",
                  type: "Permanent",
                },
              },
            }
          : { type, created_at: data.created_at, data },
    });
  }

  it("keeps a bounce when a late email.sent is redelivered", async () => {
    const id = await logged();
    await event("email.bounced");
    await event("email.sent");
    await event("email.delivery_delayed");

    const row = await t.run(async (ctx) => ctx.db.get("emailLog", id));
    expect(row).toMatchObject({ status: "bounced", error: "email.bounced" });
  });

  it("does not step back from delivered", async () => {
    const id = await logged();
    await event("email.delivered");
    await event("email.delivery_delayed");
    const row = await t.run(async (ctx) => ctx.db.get("emailLog", id));
    expect(row?.status).toBe("delivered");
  });

  it("refuses to resend an invitation to an address that bounced", async () => {
    const session = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("sessions", sessionFields(f));
      return (await ctx.db.get("sessions", sid))!;
    });
    await logged(session._id, session.candidateEmail);
    await event("email.bounced");

    await expect(
      asOwner(t).mutation(api.sessions.resendInvitation, {
        sessionId: session._id,
      }),
    ).rejects.toThrow(/address_undeliverable/);
  });
});

/* ── Back M3 ─────────────────────────────────────────────────────────────── */

describe("dashboard figures past 400 sessions (Back M3)", () => {
  let t: T;
  let f: Fixture;

  beforeEach(async () => {
    t = newTest();
    f = await seed(t);
  });

  it("counts a decision behind 450 newer invitations, and flags the capped figure", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "sessions",
        sessionFields(f, {
          status: "completed",
          completedAt: Date.now(),
          overallScore: 80,
          recruiterDecision: "hired",
        }),
      );
      for (let i = 0; i < 450; i++) {
        await ctx.db.insert("sessions", sessionFields(f));
      }
    });

    const overview = await asOwner(t).query(api.dashboard.overview, {
      orgId: f.orgId,
      now: Date.now(),
    });

    // The old query read the latest 400 sessions of any status: the hired
    // candidate fell out of it and "decisions so far" read zero.
    expect(overview.decisions.hired).toBe(1);
    expect(overview.recent).toHaveLength(1);
    expect(overview.invitedInWindow).toBe(400);
    expect(overview.capped).toEqual({
      roles: false,
      invited: true,
      completed: false,
    });
  });

  it("does not count an invitation older than the window", async () => {
    await t.run(async (ctx) => ctx.db.insert("sessions", sessionFields(f)));
    const overview = await asOwner(t).query(api.dashboard.overview, {
      orgId: f.orgId,
      now: Date.now() + 31 * DAY_MS,
    });
    expect(overview.invitedInWindow).toBe(0);
  });
});

/* ── Back F8 ─────────────────────────────────────────────────────────────── */

describe("the super-admin screen (Back F8)", () => {
  let t: T;
  let f: Fixture;

  beforeEach(async () => {
    t = newTest();
    f = await seed(t);
  });

  it("pages the organisation and user lists", async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        const userId = await ctx.db.insert("users", {
          betterAuthId: `ba_${i}`,
          email: `u${i}@example.test`,
          superAdmin: false,
          createdAt: 0,
        });
        await ctx.db.insert("organizations", {
          slug: `org-${i}`,
          name: `Org ${i}`,
          createdBy: userId,
          createdAt: 0,
        });
      }
    });
    const paginationOpts = { numItems: 10, cursor: null };
    const orgs = await asOwner(t).query(api.admin.listOrgs, { paginationOpts });
    const users = await asOwner(t).query(api.admin.listUsers, {
      paginationOpts,
    });
    expect(orgs.page).toHaveLength(10);
    expect(orgs.isDone).toBe(false);
    expect(users.page).toHaveLength(10);
    expect(users.isDone).toBe(false);
  });

  it("still refuses to drop the last super-admin, and allows it when another exists", async () => {
    await expect(
      asOwner(t).mutation(api.admin.setSuperAdmin, {
        userId: f.userId,
        value: false,
      }),
    ).rejects.toThrow(/last_super_admin/);

    await t.run(async (ctx) =>
      ctx.db.insert("users", {
        betterAuthId: "ba_other_admin",
        email: "other@acme.test",
        superAdmin: true,
        createdAt: 0,
      }),
    );
    await asOwner(t).mutation(api.admin.setSuperAdmin, {
      userId: f.userId,
      value: false,
    });
    const me = await t.run(async (ctx) => ctx.db.get("users", f.userId));
    expect(me?.superAdmin).toBe(false);
  });
});

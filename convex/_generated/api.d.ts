/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as agent from "../agent.js";
import type * as apply from "../apply.js";
import type * as auth from "../auth.js";
import type * as candidate from "../candidate.js";
import type * as chat from "../chat.js";
import type * as criteria from "../criteria.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as e2e from "../e2e.js";
import type * as email from "../email.js";
import type * as emailEvents from "../emailEvents.js";
import type * as emailTemplates from "../emailTemplates.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as interview from "../interview.js";
import type * as invitations from "../invitations.js";
import type * as jobImport from "../jobImport.js";
import type * as jobImportFetch from "../jobImportFetch.js";
import type * as lib_accountLifecycle from "../lib/accountLifecycle.js";
import type * as lib_agentScope from "../lib/agentScope.js";
import type * as lib_ai from "../lib/ai.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_candidateReturns from "../lib/candidateReturns.js";
import type * as lib_candidateView from "../lib/candidateView.js";
import type * as lib_chatLimits from "../lib/chatLimits.js";
import type * as lib_clientIp from "../lib/clientIp.js";
import type * as lib_clock from "../lib/clock.js";
import type * as lib_evidence from "../lib/evidence.js";
import type * as lib_htmlText from "../lib/htmlText.js";
import type * as lib_instructions from "../lib/instructions.js";
import type * as lib_invitations from "../lib/invitations.js";
import type * as lib_locale from "../lib/locale.js";
import type * as lib_memberName from "../lib/memberName.js";
import type * as lib_names from "../lib/names.js";
import type * as lib_objectStore from "../lib/objectStore.js";
import type * as lib_projectAccess from "../lib/projectAccess.js";
import type * as lib_prompts from "../lib/prompts.js";
import type * as lib_publishReadiness from "../lib/publishReadiness.js";
import type * as lib_reportBuilder from "../lib/reportBuilder.js";
import type * as lib_reportSchema from "../lib/reportSchema.js";
import type * as lib_safeUrl from "../lib/safeUrl.js";
import type * as lib_sessionState from "../lib/sessionState.js";
import type * as lib_sigv4 from "../lib/sigv4.js";
import type * as lib_siteUrl from "../lib/siteUrl.js";
import type * as lib_slug from "../lib/slug.js";
import type * as lib_storage from "../lib/storage.js";
import type * as lib_tokens from "../lib/tokens.js";
import type * as lib_userPrefs from "../lib/userPrefs.js";
import type * as lib_weights from "../lib/weights.js";
import type * as lib_workpools from "../lib/workpools.js";
import type * as media from "../media.js";
import type * as migrations from "../migrations.js";
import type * as notifications from "../notifications.js";
import type * as orgErasure from "../orgErasure.js";
import type * as organizations from "../organizations.js";
import type * as pipeline from "../pipeline.js";
import type * as projects from "../projects.js";
import type * as publicConfig from "../publicConfig.js";
import type * as purge from "../purge.js";
import type * as questions from "../questions.js";
import type * as rateLimiters from "../rateLimiters.js";
import type * as recruiterTools from "../recruiterTools.js";
import type * as reports from "../reports.js";
import type * as retention from "../retention.js";
import type * as sessions from "../sessions.js";
import type * as shares from "../shares.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agent: typeof agent;
  apply: typeof apply;
  auth: typeof auth;
  candidate: typeof candidate;
  chat: typeof chat;
  criteria: typeof criteria;
  crons: typeof crons;
  dashboard: typeof dashboard;
  e2e: typeof e2e;
  email: typeof email;
  emailEvents: typeof emailEvents;
  emailTemplates: typeof emailTemplates;
  files: typeof files;
  http: typeof http;
  interview: typeof interview;
  invitations: typeof invitations;
  jobImport: typeof jobImport;
  jobImportFetch: typeof jobImportFetch;
  "lib/accountLifecycle": typeof lib_accountLifecycle;
  "lib/agentScope": typeof lib_agentScope;
  "lib/ai": typeof lib_ai;
  "lib/auth": typeof lib_auth;
  "lib/candidateReturns": typeof lib_candidateReturns;
  "lib/candidateView": typeof lib_candidateView;
  "lib/chatLimits": typeof lib_chatLimits;
  "lib/clientIp": typeof lib_clientIp;
  "lib/clock": typeof lib_clock;
  "lib/evidence": typeof lib_evidence;
  "lib/htmlText": typeof lib_htmlText;
  "lib/instructions": typeof lib_instructions;
  "lib/invitations": typeof lib_invitations;
  "lib/locale": typeof lib_locale;
  "lib/memberName": typeof lib_memberName;
  "lib/names": typeof lib_names;
  "lib/objectStore": typeof lib_objectStore;
  "lib/projectAccess": typeof lib_projectAccess;
  "lib/prompts": typeof lib_prompts;
  "lib/publishReadiness": typeof lib_publishReadiness;
  "lib/reportBuilder": typeof lib_reportBuilder;
  "lib/reportSchema": typeof lib_reportSchema;
  "lib/safeUrl": typeof lib_safeUrl;
  "lib/sessionState": typeof lib_sessionState;
  "lib/sigv4": typeof lib_sigv4;
  "lib/siteUrl": typeof lib_siteUrl;
  "lib/slug": typeof lib_slug;
  "lib/storage": typeof lib_storage;
  "lib/tokens": typeof lib_tokens;
  "lib/userPrefs": typeof lib_userPrefs;
  "lib/weights": typeof lib_weights;
  "lib/workpools": typeof lib_workpools;
  media: typeof media;
  migrations: typeof migrations;
  notifications: typeof notifications;
  orgErasure: typeof orgErasure;
  organizations: typeof organizations;
  pipeline: typeof pipeline;
  projects: typeof projects;
  publicConfig: typeof publicConfig;
  purge: typeof purge;
  questions: typeof questions;
  rateLimiters: typeof rateLimiters;
  recruiterTools: typeof recruiterTools;
  reports: typeof reports;
  retention: typeof retention;
  sessions: typeof sessions;
  shares: typeof shares;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  mediaWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"mediaWorkpool">;
  reportWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"reportWorkpool">;
};

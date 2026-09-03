import { createClient } from 'redis';

type AppRedisClient = ReturnType<typeof createClient>;
import { RedisMemoryServer } from 'redis-memory-server';
import mongoose, { type InferSchemaType, type HydratedDocument } from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

mongoose.set('strictQuery', true);


function resolveRedisUrl(): string {
  const direct = process.env.REDIS_URL?.trim();
  if (direct) return direct;
  const host = process.env.REDIS_HOST?.trim() || '127.0.0.1';
  const port = process.env.REDIS_PORT?.trim() || '6379';
  return `redis://${host}:${port}`;
}

let redisClientPromise: Promise<AppRedisClient> | null = null;
let memoryServer: RedisMemoryServer | undefined;

async function connectSharedRedis(url: string): Promise<AppRedisClient> {
  const client = createClient({ url });
  client.on('error', (err) => console.error('Redis client error:', err));
  await client.connect();
  const masked = url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
  console.log(`🚀 Redis connected (${masked})`);
  return client;
}

async function connectMemoryServerRedis(): Promise<AppRedisClient> {
  memoryServer ??= new RedisMemoryServer();
  const host = await memoryServer.getHost();
  const port = await memoryServer.getPort();
  return connectSharedRedis(`redis://${host}:${port}`);
}

export async function getRedisClient(): Promise<AppRedisClient> {
  redisClientPromise ??= (async () => {
    const useMemory = process.env.REDIS_USE_MEMORY_SERVER === 'true' || process.env.REDIS_USE_MEMORY_SERVER === '1';
    if (useMemory) return connectMemoryServerRedis();
    return connectSharedRedis(resolveRedisUrl());
  })();
  return redisClientPromise;
}

export async function disconnectRedis(): Promise<void> {
  if (!redisClientPromise) return;
  const clientPromise = redisClientPromise;
  redisClientPromise = null;
  const client = await clientPromise.catch(() => null);
  if (client?.isOpen) await client.quit();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = undefined;
  }
}

let mongoConnectPromise: Promise<typeof mongoose> | null = null;
let mongoListenersAttached = false;

function attachMongoListeners() {
  if (mongoListenersAttached) return;
  mongoListenersAttached = true;
  mongoose.connection.on('error', (err) => console.error('Mongo connection error:', err));
  mongoose.connection.on('disconnected', () => console.warn('Mongo disconnected'));
  mongoose.connection.on('reconnected', () => console.log('Mongo reconnected'));
}

export async function connectMongo(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (mongoConnectPromise) return mongoConnectPromise;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');

  attachMongoListeners();

  mongoConnectPromise = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 10,
      autoIndex: process.env.NODE_ENV !== 'production',
    })
    .then((m) => {
      console.log(`🚀 Mongo Live at ${m.connection.host}`);
      return m;
    })
    .catch((err) => {
      mongoConnectPromise = null;
      throw err;
    });

  return mongoConnectPromise;
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  mongoConnectPromise = null;
}

const userResourceWatchlistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    resources: [
      {
        _id: false,
        arn: { type: String, required: true },
        actions: [{ type: String }],
      },
    ],
  },
  { timestamps: true },
);

const userPermissionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    permissionsData: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true, minimize: false },
);

export type UserResourceWatchlist = InferSchemaType<typeof userResourceWatchlistSchema>;
export type UserResourceWatchlistDoc = HydratedDocument<UserResourceWatchlist>;
export type UserPermission = InferSchemaType<typeof userPermissionSchema>;
export type UserPermissionDoc = HydratedDocument<UserPermission>;

export const UserResourceWatchlistModel =
  (mongoose.models.UserResourceWatchlist as mongoose.Model<UserResourceWatchlist>) ??
  mongoose.model<UserResourceWatchlist>('UserResourceWatchlist', userResourceWatchlistSchema);

export const UserPermissionModel =
  (mongoose.models.UserPermission as mongoose.Model<UserPermission>) ??
  mongoose.model<UserPermission>('UserPermission', userPermissionSchema);

const userSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  source:      { type: String, enum: ['IAM', 'SSO'], required: true },
  externalId:  { type: String, required: true },  // IAM UserId (AIDA…) or SSO UserId (UUID)
  arn:         { type: String, default: null },   // null for SSO
  lastSeenAt:  { type: Date,   required: true },
  slackUserId: { type: String, default: null },   // Slack DM/member id for notifications; set manually, userSync $set never touches it
});
userSchema.index({ source: 1, externalId: 1 }, { unique: true });

export const UserModel = mongoose.model('User', userSchema);

// ==========================================
// AwsResource — catalogue of every discovered AWS resource
// ==========================================
const awsResourceSchema = new mongoose.Schema(
  {
    arn: { type: String, required: true },
    resourceType: {
      type: String,
      enum: ['S3Bucket', 'IAMUser', 'IAMRole', 'IAMGroup', 'SSOUser', 'SSOGroup', 'PermissionSet', 'EC2Instance'],
      required: true,
    },
    name: { type: String, required: true },
    accountId: { type: String },
    region: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    lastSyncedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
awsResourceSchema.index({ arn: 1 }, { unique: true });
awsResourceSchema.index({ resourceType: 1, accountId: 1 });

export type AwsResource = InferSchemaType<typeof awsResourceSchema>;
export type AwsResourceDoc = HydratedDocument<AwsResource>;

export const AwsResourceModel =
  (mongoose.models.AwsResource as mongoose.Model<AwsResource>) ??
  mongoose.model<AwsResource>('AwsResource', awsResourceSchema);

// ==========================================
// ResourceAction — IAM actions extracted from policies on each resource
// ==========================================
const resourceActionSchema = new mongoose.Schema(
  {
    resourceType: { type: String, required: true, index: true },
    actionName: { type: String, required: true },
    policySource: { type: String }, // 'BucketPolicy' | 'AttachedPolicy' | 'InlinePolicy' | 'PermissionSet'
    policyArn: { type: String },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true },
);
resourceActionSchema.index({ resourceType: 1, actionName: 1 }, { unique: true });

export type ResourceAction = InferSchemaType<typeof resourceActionSchema>;
export type ResourceActionDoc = HydratedDocument<ResourceAction>;

export const ResourceActionModel =
  (mongoose.models.ResourceAction as mongoose.Model<ResourceAction>) ??
  mongoose.model<ResourceAction>('ResourceAction', resourceActionSchema);

// ==========================================
// Company — an organisation that has onboarded to Aura
// ==========================================
const companySchema = new mongoose.Schema(
  {
    name:       { type: String, required: true },
    slug:       { type: String, required: true },          // URL-safe identifier, e.g. "acme"
    inviteCode: { type: String, required: true },          // 6-digit code required for employee signup
    // Bumped inside the last-manager-guard transaction (never read for its value) so that
    // two concurrent guarded ops on the same company touch the same doc and collide as a
    // real MongoDB write conflict instead of racing past a stale count (write-skew).
    managerOpsSeq: { type: Number, default: 0 },
    awsCredentials: {
      accessKeyId:     { type: String },
      // Stored encrypted via encryptSecret() — see utils/src/crypto.ts
      secretAccessKey: { type: String },
      status:          { type: String, enum: ['connected', 'disconnected', 'error'] },
      connectedAt:     { type: Date },
    },
  },
  { timestamps: true },
);
companySchema.index({ slug: 1 }, { unique: true });

export type Company = InferSchemaType<typeof companySchema>;
export type CompanyDoc = HydratedDocument<Company>;

export const CompanyModel =
  (mongoose.models.Company as mongoose.Model<Company>) ??
  mongoose.model<Company>('Company', companySchema);

// ==========================================
// Customer — an individual user belonging to a Company
// ==========================================
const customerSchema = new mongoose.Schema(
  {
    firstName:        { type: String, required: true },
    lastName:         { type: String, required: true },
    email:            { type: String, required: true },
    roleTitle:        { type: String, required: true },
    passwordHash:     { type: String, required: true },
    role:             { type: String, enum: ['manager', 'employee'], required: true },
    companyId:        { type: String, required: true },    // references Company._id
    linkedAwsUserId:  { type: String, default: null },     // stores User.externalId (AWS SSO/IAM UserId); null until selected
    teamId:           { type: String, default: null },     // references Team._id; at most one team per employee in v1
  },
  { timestamps: true },
);
customerSchema.index({ email: 1 }, { unique: true });
customerSchema.index({ companyId: 1 });

export type Customer = InferSchemaType<typeof customerSchema>;
export type CustomerDoc = HydratedDocument<Customer>;

export const CustomerModel =
  (mongoose.models.Customer as mongoose.Model<Customer>) ??
  mongoose.model<Customer>('Customer', customerSchema);

// ==========================================
// Team — a named group of employees within a Company
// ==========================================
const teamSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, index: true }, // references Company._id
    name:      { type: String, required: true, trim: true },
  },
  { timestamps: true },
);
teamSchema.index({ companyId: 1, name: 1 }, { unique: true });

export type Team = InferSchemaType<typeof teamSchema>;
export type TeamDoc = HydratedDocument<Team>;

export const TeamModel =
  (mongoose.models.Team as mongoose.Model<Team>) ??
  mongoose.model<Team>('Team', teamSchema);

// ==========================================
// WatchlistPreset — a resource-watchlist template applied to a team or an individual
// ==========================================
const watchlistPresetSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, index: true },        // denormalized for cheap tenancy checks
    scopeType: { type: String, enum: ['team', 'individual'], required: true },
    scopeId:   { type: String, required: true },                     // Team._id when scopeType='team', Customer._id when 'individual'
    name:      { type: String },
    resources: [
      {
        _id: false,
        arn: { type: String, required: true },
        actions: [{ type: String }],
      },
    ],
    createdBy: { type: String },                                     // Customer._id, informational only
  },
  { timestamps: true },
);
watchlistPresetSchema.index({ scopeType: 1, scopeId: 1 }, { unique: true });

export type WatchlistPreset = InferSchemaType<typeof watchlistPresetSchema>;
export type WatchlistPresetDoc = HydratedDocument<WatchlistPreset>;

export const WatchlistPresetModel =
  (mongoose.models.WatchlistPreset as mongoose.Model<WatchlistPreset>) ??
  mongoose.model<WatchlistPreset>('WatchlistPreset', watchlistPresetSchema);

// ==========================================
// OAuthClient — an AI client that registered itself via Dynamic Client Registration
// ==========================================
const oauthClientSchema = new mongoose.Schema(
  {
    clientId:              { type: String, required: true },
    clientName:            { type: String, default: null },       // self-reported at registration, never verified
    redirectUris:          [{ type: String, required: true }],
    // The MCP SDK compares the presented secret against this value verbatim, so it
    // cannot be hashed. Public clients (PKCE only, which is what AI clients use) leave it null.
    clientSecret:          { type: String, default: null },
    clientSecretExpiresAt: { type: Number, default: null },       // seconds since epoch; 0 means never
  },
  { timestamps: true },
);
oauthClientSchema.index({ clientId: 1 }, { unique: true });

export type OAuthClient = InferSchemaType<typeof oauthClientSchema>;
export type OAuthClientDoc = HydratedDocument<OAuthClient>;

export const OAuthClientModel =
  (mongoose.models.OAuthClient as mongoose.Model<OAuthClient>) ??
  mongoose.model<OAuthClient>('OAuthClient', oauthClientSchema);

// ==========================================
// OAuthGrant — one customer's standing authorization for one AI client
// ==========================================
const oauthGrantSchema = new mongoose.Schema(
  {
    customerId:       { type: String, required: true, index: true },  // references Customer._id
    clientId:         { type: String, required: true },               // references OAuthClient.clientId
    refreshTokenHash: { type: String, required: true, index: true },  // sha256 of the opaque refresh token
    scopes:           [{ type: String }],                             // always ['full'] today; kept so granular grants stay possible
    lastUsedAt:       { type: Date, default: null },
  },
  { timestamps: true },
);
oauthGrantSchema.index({ customerId: 1, clientId: 1 }, { unique: true });

export type OAuthGrant = InferSchemaType<typeof oauthGrantSchema>;
export type OAuthGrantDoc = HydratedDocument<OAuthGrant>;

export const OAuthGrantModel =
  (mongoose.models.OAuthGrant as mongoose.Model<OAuthGrant>) ??
  mongoose.model<OAuthGrant>('OAuthGrant', oauthGrantSchema);

// ==========================================
// OAuthAuthCode — a one-time code handed to a client after the user approves consent
// ==========================================
const oauthAuthCodeSchema = new mongoose.Schema(
  {
    code:          { type: String, required: true },
    customerId:    { type: String, required: true },   // references Customer._id
    clientId:      { type: String, required: true },   // references OAuthClient.clientId
    redirectUri:   { type: String, required: true },   // must match the one presented at token exchange
    codeChallenge: { type: String, required: true },   // PKCE S256 challenge
    scopes:        [{ type: String }],
    expiresAt:     { type: Date, required: true },
  },
  { timestamps: true },
);
oauthAuthCodeSchema.index({ code: 1 }, { unique: true });
// Mongo's TTL monitor only sweeps about once a minute, so an expired code can still
// be readable. Readers must check expiresAt themselves; this index is cleanup, not enforcement.
oauthAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type OAuthAuthCode = InferSchemaType<typeof oauthAuthCodeSchema>;
export type OAuthAuthCodeDoc = HydratedDocument<OAuthAuthCode>;

export const OAuthAuthCodeModel =
  (mongoose.models.OAuthAuthCode as mongoose.Model<OAuthAuthCode>) ??
  mongoose.model<OAuthAuthCode>('OAuthAuthCode', oauthAuthCodeSchema);

export { mongoose };
export type { RedisClientType } from 'redis';
export * from './utils.js';
export * from './crypto.js';
export * from './consts.js';
export * from './resourceStatus.js';
export * from './watchedResources.js';
export * from './evaluator.js';
export * from './identity/types.js';
export * from './identity/policyBindings.js';
export * from './identity/loadUser.js';
export * from './identity/resolveIdentity.js';
export * from './policyCache.js';

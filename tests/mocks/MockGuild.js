import { MockCollection } from './MockCollection.js';
import { MockRole } from './MockRole.js';
import { MockMember } from './MockMember.js';

/**
 * Mock discord.js Guild for unit testing.
 * Configurable owner, members, roles, channels.
 * No dependency on discord.js — uses MockCollection.
 */
export class MockGuild {
    constructor({
        id = 'guild-001',
        name = 'TestGuild',
        ownerId = 'owner-001',
        members = [],
        roles = [],
        channels = [],
        iconURL = null,
    } = {}) {
        this.id = id;
        this.name = name;
        this.ownerId = ownerId;
        this.iconURL = () => iconURL;
        this.verificationLevel = 1;
        this.invitesDisabled = false;

        // Members
        this.members = {
            cache: new MockCollection(),
            me: null,
            fetch: async (userId) => {
                const member = members.find((m) => m.id === userId || m.user?.id === userId);
                if (member) return member;
                throw new Error(`Member ${userId} not found`);
            },
            ban: async (userId, options) => {
                return Promise.resolve();
            },
            kick: async (userId, reason) => {
                return Promise.resolve();
            },
            unban: async (userId, reason) => {
                return Promise.resolve();
            },
        };
        members.forEach((m) => this.members.cache.set(m.id, m));

        // Roles
        const everyoneRole = new MockRole({ id: this.id, name: '@everyone', position: 0 });
        this.roles = {
            cache: new MockCollection([[this.id, everyoneRole]]),
            highest: everyoneRole,
            fetch: async (roleId) => this.roles.cache.get(roleId) || null,
            create: async (payload) => {
                const newRole = new MockRole({ id: `role-${Date.now()}`, ...payload });
                this.roles.cache.set(newRole.id, newRole);
                return newRole;
            },
            find: (fn) => {
                for (const [, role] of this.roles.cache) {
                    if (fn(role)) return role;
                }
                return null;
            },
        };
        roles.forEach((r) => this.roles.cache.set(r.id, r));

        // Channels
        this.channels = {
            cache: new MockCollection(),
            fetch: async (channelId) => this.channels.cache.get(channelId) || null,
        };
        channels.forEach((ch) => this.channels.cache.set(ch.id, ch));

        // Audit logs
        this.fetchAuditLogs = async () => ({
            entries: {
                values: () => [],
            },
        });

        // Bans
        this.bans = {
            fetch: async () => new MockCollection(),
        };

        // Guild edit
        this.edit = async (options) => {
            if (options.verificationLevel !== undefined) {
                this.verificationLevel = options.verificationLevel;
            }
            if (options.invitesDisabled !== undefined) {
                this.invitesDisabled = options.invitesDisabled;
            }
            return this;
        };

        // Client reference
        this.client = {
            user: { id: 'bot-001', tag: 'Bot#0000', username: 'TestBot' },
            commands: new MockCollection(),
            db: {
                get: async () => ({}),
                set: async () => true,
                isAvailable: () => true,
                getStatus: () => ({ isDegraded: false, connectionType: 'postgresql' }),
                increment: async () => 1,
            },
            guilds: {
                cache: new MockCollection([[this.id, this]]),
                fetch: async () => this,
            },
            users: {
                fetch: async (id) => ({ id, tag: `User#${id.slice(-4)}`, bot: false, send: () => Promise.resolve() }),
            },
        };
    }

    setupBotMember(botMember) {
        this.members.me = botMember;
    }
}

export default MockGuild;
import { MockCollection } from './MockCollection.js';

/**
 * Mock discord.js TextChannel for unit testing.
 * No dependency on discord.js — uses MockCollection.
 */
export class MockChannel {
    constructor({
        id = 'channel-001',
        name = 'test-channel',
        guild = null,
        permissionOverwrites = null,
    } = {}) {
        this.id = id;
        this.name = name;
        this.guild = guild;
        this.type = 0; // GUILD_TEXT
        this.topic = null;
        this.nsfw = false;
        this.rateLimitPerUser = 0;
        this.parentId = null;
        this.position = 0;

        this.permissionOverwrites = {
            cache: new MockCollection(),
            edit: async () => this,
        };

        if (permissionOverwrites) {
            Object.entries(permissionOverwrites).forEach(([key, val]) => {
                this.permissionOverwrites.cache.set(key, val);
            });
        }

        this.messages = {
            cache: new MockCollection(),
            fetch: async (options = {}) => {
                const result = new MockCollection();
                if (options.limit) {
                    for (let i = 0; i < Math.min(options.limit, this._storedMessages?.length || 0); i++) {
                        const msg = this._storedMessages[i];
                        result.set(msg.id, msg);
                    }
                }
                if (options.before) {
                    const beforeIdx = this._storedMessages?.findIndex((m) => m.id === options.before);
                    const start = beforeIdx > 0 ? beforeIdx : 0;
                    const end = Math.min(start + (options.limit || 100), this._storedMessages?.length || 0);
                    for (let i = start; i < end; i++) {
                        const msg = this._storedMessages[i];
                        result.set(msg.id, msg);
                    }
                }
                return result;
            },
            delete: async () => true,
        };

        this._storedMessages = [];

        this.bulkDelete = async (messages, filterOld) => {
            const ids = Array.isArray(messages)
                ? messages.map((m) => m.id)
                : [...messages.keys()];
            this._storedMessages = this._storedMessages.filter((m) => !ids.includes(m.id));
            return new MockCollection(ids.map((id) => [id, { id }]));
        };

        this.delete = async () => this;
    }

    isTextBased() {
        return true;
    }

    send(options) {
        const msg = {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            content: typeof options === 'string' ? options : options?.content || '',
            author: { id: 'bot-001', bot: true },
            channel: this,
            delete: async () => true,
            createdTimestamp: Date.now(),
        };
        this._storedMessages.unshift(msg);
        return Promise.resolve(msg);
    }

    permissionsFor(member) {
        return {
            has: () => true,
        };
    }

    isCategoryBased() {
        return false;
    }

    createOverwrite(role, perms) {
        return Promise.resolve();
    }

    toString() {
        return `<#${this.id}>`;
    }
}

export default MockChannel;
/**
 * Mock discord.js User for unit testing.
 * Configurable bot flag, tag, and ID.
 */
export class MockUser {
    constructor({ id = 'user-001', username = 'TestUser', discriminator = '0001', bot = false } = {}) {
        this.id = id;
        this.username = username;
        this.discriminator = discriminator;
        this.bot = bot;
        this.tag = `${username}#${discriminator}`;
        this.displayName = username;
        this.system = false;
        this.createdTimestamp = Date.now() - 86400000; // 1 day ago
        this.createdAt = new Date(this.createdTimestamp);
    }

    toString() {
        return `<@${this.id}>`;
    }

    // Stub DM creation
    createDM() {
        return Promise.resolve({
            id: `dm-${this.id}`,
            send: () => Promise.resolve({ id: 'msg-dm-001' }),
        });
    }

    send(options) {
        return Promise.resolve({ id: 'msg-dm-001', ...options });
    }
}

export default MockUser;
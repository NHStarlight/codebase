/**
 * Mock discord.js Role for unit testing.
 */
export class MockRole {
    constructor({
        id = 'role-001',
        name = 'TestRole',
        position = 1,
        permissions = [],
        color = 0,
        hoist = false,
        mentionable = false,
        managed = false,
    } = {}) {
        this.id = id;
        this.name = name;
        this.position = position;
        this._permissions = permissions;
        this.color = color;
        this.hoist = hoist;
        this.mentionable = mentionable;
        this.managed = managed;
    }

    get permissions() {
        if (typeof this._permissions.has === 'function') {
            return this._permissions;
        }
        const perms = Array.isArray(this._permissions) ? this._permissions : [this._permissions];
        return {
            has: (perm) => perms.includes(perm) || perms.includes('ADMINISTRATOR'),
        };
    }

    toString() {
        return `<@&${this.id}>`;
    }
}

export default MockRole;
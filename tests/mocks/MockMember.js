import { MockCollection } from './MockCollection.js';
import { MockRole } from './MockRole.js';

/**
 * Mock discord.js GuildMember for unit testing.
 * Role hierarchy is derived from role positions.
 * No dependency on discord.js — uses MockCollection.
 */
export class MockMember {
    constructor({
        id = 'member-001',
        guild = null,
        permissions = [],
        roles = [],
        _rolesCollection = null,
        isOwner = false,
    } = {}) {
        this.id = id;
        this.guild = guild;
        this.user = {
            id: id,
            tag: `User#${id.slice(-4)}`,
            username: `User${id.slice(-4)}`,
            bot: false,
            send: () => Promise.resolve({ id: 'dm-msg' }),
            createDM: () => Promise.resolve({ id: `dm-${id}`, send: () => Promise.resolve({}) }),
        };
        this.nickname = null;
        this._permissions = permissions;
        this._isOwner = isOwner;
        this._rolesArray = roles;

        this.roles = {
            cache: _rolesCollection || new MockCollection(),
            highest: roles.length > 0
                ? roles.reduce((a, b) => (a.position > b.position ? a : b))
                : new MockRole({ id: '@everyone', name: '@everyone', position: 0 }),
            add: () => Promise.resolve(),
            remove: () => Promise.resolve(),
            set: () => Promise.resolve(this),
        };

        if (guild && guild.roles) {
            this.roles = guild.roles;
        }

        this.kickable = true;
        this.bannable = true;
        this.moderatable = true;
        this.manageable = true;
    }

    get permissions() {
        if (typeof this._permissions.has === 'function') {
            return this._permissions;
        }
        const perms = Array.isArray(this._permissions)
            ? this._permissions
            : [this._permissions];
        return {
            has: (perm) => {
                const check = Array.isArray(perm) ? perm : [perm];
                return check.every(
                    (p) => perms.includes(p) || perms.includes('ADMINISTRATOR'),
                );
            },
        };
    }

    isCommunicationDisabled() {
        return false;
    }

    timeout(duration, reason) {
        return Promise.resolve(this);
    }

    kick(reason) {
        return Promise.resolve(this);
    }

    ban(options) {
        return Promise.resolve(this);
    }

    fetch(force) {
        return Promise.resolve(this);
    }

    setNickname(nick) {
        this.nickname = nick;
        return Promise.resolve(this);
    }
}

export default MockMember;
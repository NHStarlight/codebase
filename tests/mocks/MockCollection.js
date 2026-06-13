/**
 * Minimal Map-based Collection polyfill (replaces discord.js Collection).
 * Used by mock objects so tests don't require discord.js installed.
 */
export class MockCollection extends Map {
    find(fn) {
        for (const [key, value] of this) {
            if (fn(value, key, this)) return value;
        }
        return undefined;
    }

    filter(fn) {
        const results = new MockCollection();
        for (const [key, value] of this) {
            if (fn(value, key, this)) results.set(key, value);
        }
        return results;
    }

    map(fn) {
        const results = [];
        for (const [key, value] of this) {
            results.push(fn(value, key, this));
        }
        return results;
    }

    first() {
        return this.values().next().value;
    }

    firstKey() {
        return this.keys().next().value;
    }

    last() {
        const arr = [...this.values()];
        return arr[arr.length - 1];
    }

    reduce(fn, initial) {
        let acc = initial;
        for (const [key, value] of this) {
            acc = fn(acc, value, key, this);
        }
        return acc;
    }

    some(fn) {
        for (const [key, value] of this) {
            if (fn(value, key, this)) return true;
        }
        return false;
    }

    every(fn) {
        for (const [key, value] of this) {
            if (!fn(value, key, this)) return false;
        }
        return true;
    }

    clone() {
        const copy = new MockCollection();
        for (const [key, value] of this) {
            copy.set(key, value);
        }
        return copy;
    }

    toJSON() {
        return [...this.entries()];
    }
}

export default MockCollection;
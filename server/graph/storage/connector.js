'use strict';

const _ = require('lodash');
const Promise = require('bluebird');

const querystring = require('querystring');

const rp = require('request-promise');
const DataLoader = require('dataloader');

const baseLog = require('../../log');

const ROOT_URL = 'https://psychonautwiki.org/w/api.php';

const qsDefaults = {
    action: 'ask',
    format: 'json'
};

/*
    Caching algorithm:

    0. let synchronous be true
    1. check if item is in store
    2. if in store, check ttl
        2.1 let requireRefresh be false
        2.2 let refreshInProgress be false
        2.3 if expired, let requireRefresh be true
        2.4 if refreshInProgress is true
            2.4.1 return existing data; go to 3.
        2.5 let refreshInProgress be true
        2.6 let synchronous be false
        2.7 return existing data
    3. obtain new data, in background if synchronous is false
    3.1 insert new data into cache
    3.2 let requireRefresh be false
    3.3 let refreshInProgress be false
    3.4 return new data if synchronous is true
*/

class BifrostCache {
    constructor({log}) {
        this._log = log.child({
            type: 'bifrostCache'
        });

        // thirty minutes
        this._CACHE_LIFETIME = 30 * 60 * 1000;

        this._backend = new Map();
        this._processMap = new Map();
    }

    /* this._log.trace('Key invalidated, removing: `%s` (ttl: %s)', key, Date.now() - item.ts); */

    get(key) {
        const cachedItem = this._backend.get(key);

        if (!cachedItem) {
            return null;
        }

        const {ts, val} = cachedItem;

        let requireRefresh = false;

        if ((Date.now() - ts) > this._CACHE_LIFETIME) {
            requireRefresh = true;
        }

        return {val, requireRefresh};
    }

    isBeingRefreshed(key) {
        return this._processMap.get(key) !== undefined;
    }

    markBeingRefreshed(key, isBeingRefreshed) {
        if (!isBeingRefreshed) {
            return this._processMap.delete(key);
        }

        return this._processMap.set(key, true);
    }

    add(key, val) {
        this._log.trace('Adding key: `%s\'', key);

        return this._backend.set(key, {
            ts: Date.now(), val
        });
    }
}

const sharedBifrostCache = new BifrostCache({
    log: baseLog
});

class PwConnector {
    constructor({log}) {
        this._rp = rp;
        this._log = log.child({
            type: 'PwConnector'
        });

        this._loader = new DataLoader(this.fetch.bind(this), {
            batch: true
        });

        this._cache = sharedBifrostCache;

        this._fetchOptions = {
            json: true,
            resolveWithFullResponse: true,
            headers: {
                'user-agent': 'Bifrost'
            }
        };
    }

    _buildFetchOptions(url) {
        return _.assign({
            uri: url
        }, this._fetchOptions);
    }

    _fetchUrl(url) {
        return this._rp(this._buildFetchOptions(url));
    }

    * _fetchRefreshedCacheItem(url) {
        this._log.trace('Fetching item: `%s`', url);

        const response = yield this._fetchUrl(url);

        this._cache.add(url, response);

        return response;
    }

    * _getCacheIfNeeded(url) {
        const cacheState = this._cache.get(url);

        /* todo: handle state when key doesnt exist and fetch is in progress */

        if (cacheState === null) {
            const res = yield* this._fetchRefreshedCacheItem(url);

            return res.body;
        }

        const {val, requireRefresh} = cacheState;

        if (requireRefresh && !this._cache.isBeingRefreshed(url)) {
            this._unwindMarkAndRefreshItem(url);

            this._log.trace('Returning expired value of item: `%s`', url);
        }

        return val.body;
    }

    fetch(urls) {
        return Promise.all(urls.map(url =>
            this._loadUrl(url)
        ));
    }

    * get(args) {
        const params = querystring.encode(_.defaults(args, qsDefaults));

        return yield this._loader.load(`${ROOT_URL}?${params}`);
    }

    _unwindMarkAndRefreshItem(url) {
        this._log.trace('Marking item as being refreshed and unwinding update: `%s`', url);

        /*
         * This method ensures the synchronous marking
         * of an item being refreshed before unwinding
         * the markAndRefreshItem routine from this
         * cycle.
         */

        this._cache.markBeingRefreshed(url, true);

        /*
         * This invocation escapes the synchronous
         * context of the generator being inhabited.
         */
        process.nextTick(() =>
            this._markAndRefreshItemAsync(url)
        );
    }
}

PwConnector.prototype._loadUrl = Promise.coroutine(function* (url) {
    try {
        this._log.debug('Trying to load url: `%s`', url);

        return yield* this._getCacheIfNeeded(url);
    } catch (err) {
        this._log.debug('Failed to load url: `%s`', err.message);

        throw err;
    }
});

PwConnector.prototype._markAndRefreshItemAsync = Promise.coroutine(function* (url) {
    this._log.trace('[markAndRefreshAsync] Fetching item: `%s`', url);

    yield* this._fetchRefreshedCacheItem(url);

    this._log.trace('[markAndRefreshAsync] Marking item as not being refreshed: `%s`', url);

    this._cache.markBeingRefreshed(url, false);
});

module.exports = PwConnector;

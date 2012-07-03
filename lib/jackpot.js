'use strict';

var EventEmitter = require('events').EventEmitter
  , retry = require('retry');

/**
 * A net.Stream connection pool.
 *
 * @constructor
 * @param {Number} limit size of the connection pool
 * @param {Function} builder stream factory
 * @api public
 */

function Manager(limit, builder) {
  this.limit = +limit || 20; // defaults to 20 connections max
  this.pool = [];
  this.pending = 0;
  this.generator = null;
  this.retries = 5;

  // some stats that can be used for metrics
  this.metrics = {
      allocations: 0
    , releases: 0
  };

  if (builder) this.factory(builder);
  EventEmitter.call(this);
}

Manager.prototype = new EventEmitter();
Manager.prototype.constructor = Manager;

/**
 * Add a stream generator so we can generate streams for the pool.
 *
 * @param {Function} builder
 * @api public
 */

Manager.prototype.factory = function factory(builder) {
  if (typeof builder !== 'function') {
    throw new Error('The #factory requires a function');
  }

  this.generator = builder;
};

/**
 * Start listening to events that could influence the state of the connection.
 *
 * @param {net.Connection} net
 * @api private
 */

Manager.prototype.listen = function listen(net) {
  if (!net) return;

  var self = this;

  /**
   * Simple helper function that allows us to automatically remove the
   * connection from the pool when we are unable to connect using it.
   *
   * @param {Error} err optional error
   * @api private
   */

  function regenerate(err) {
    net.destroySoon();

    self.remove(net);
    net.removeListener('error', regenerate);
    net.removeListener('end', regenerate);

    if (err) self.emit('error', err);
  }

  // listen for events that would mess up the connection
  net.on('error', regenerate)
     .on('end', regenerate);
};

/**
 * A fault tolerant connection allocation wrapper.
 *
 * @param {Function} fn
 * @api private
 */

Manager.prototype.pull = function pull(fn) {
  var operation = retry.operation({
          retries: this.retries
        , factor: 3
        , minTimeout: 1 * 1000
        , maxTimeout: 60 * 1000
        , randomize: true
      })
    , self = this;

  /**
   * Small wrapper around pulling a connection
   *
   * @param {Error} err
   * @api private
   */

  function allocate(err) {
    if (operation.retry(err)) return;

    fn.apply(fn, arguments);
  }

  operation.attempt(function attempt() {
    self.allocate(allocate);
  });
};

/**
 * Allocate a new connection from the connection pool, this can be done async
 * that's why we use a error first callback pattern.
 *
 * @param {Function} fn
 * @api public
 */

Manager.prototype.allocate = function allocate(fn) {
  if (!this.generator) return fn(new Error('Specify a stream #factory'));

  /**
   * Small helper function that allows us to correctly call the callback with
   * the correct arguments when we generate a new connection as the connection
   * should be emitting 'connect' befor we can use it. But it can also emit
   * error if it fails to connect.
   *
   * @param {Error} err
   * @api private
   */

  function either(err) {
    this.removeListener('error', either);
    this.removeListener('connect', either);

    // add to the pool
    self.pool.push(this);
    self.pending--;

    fn(err, this);
  }

  var probabilities = []
    , self = this
    , total, i, probability, connection;

  i = total = this.pool.length;

  // increase the allocation metric
  this.metrics.allocations++;

  // check the current pool if we already have a few connections available, so
  // we don't have to generate a new connection
  while (i--) {
    connection = this.pool[i];
    probability = this.isAvailable(connection);

    // we are sure this connection works
    if (probability === 100) return fn(undefined, connection);

    // no accurate match, add it to the queue as we can get the most likely
    // available connection
    probabilities.push({
        probability: probability
      , connection: connection
    });
  }

  // we didn't find a confident match, see if we are allowed to generate a fresh
  // connection
  if ((this.pool.length + this.pending) < this.limit) {
    // determin if the function expects a callback or not, this can be done by
    // checking the length of the given function, as the amount of args accepted
    // equals the length..
    if (this.generator.length === 0) {
      connection = this.generator();

      if (connection) {
        this.pending++;
        this.listen(connection);
        return connection.on('error', either).on('connect', either);
      }
    } else {
      return this.generator(function generate(err, connection) {
        if (err) return fn(err);
        if (!connection) return fn(new Error('The #factory failed to generate a stream'));

        self.pending++;
        self.listen(connection);
        return connection.on('error', either).on('connect', either);
      });
    }
  }

  // o, dear, we got issues.. we didn't find a valid connection and we cannot
  // create more.. so we are going to check if we might have semi valid
  // connection by sorting the probabilities array and see if it has
  // a probability above 60
  probability = probabilities.sort(function sort(a, b) {
    return a.probability - b.probability;
  }).pop();

  if (probability && probability.probability >= 60) {
    return fn(undefined, probability.connection);
  }

  // well, that didn't work out, so assume failure
  fn(new Error('The connection pool is full'));
};

/**
 * Check if a connection is available for writing.
 *
 * @param {net.Connection} net
 * @param {Boolean} ignore ignore closed or dead connections
 * @returns {Number} probability that his connection is available or will be
 * @api private
 */

Manager.prototype.isAvailable = function isAvailable(net, ignore) {
  var readyState = net.readyState
    , writable = readyState === 'open' || readyState === 'writeOnly'
    , writePending = net._pendingWriteReqs || 0
    , writeQueue = net._writeQueue || []
    , writes = writeQueue.length || writePending;

  // if the stream is writable and we don't have anything pending we are 100%
  // sure that this stream is available for writing
  if (writable && writes === 0) return 100;

  // the connection is already closed or has been destroyed, why on earth are we
  // getting it then, remove it from the pool and return 0
  if (readyState === 'closed' || net.destroyed) {
    this.remove(net);
    return 0;
  }

  // if the stream isn't writable we aren't that sure..
  if (!writable) return 0;

  // the connection is still opening, so we can write to it in the future
  if (readyState === 'opening') return 70;

  // we have some writes, so we are going to substract that amount from our 100
  if (writes < 100) return 100 - writes;

  // we didn't find any reliable states of the stream, so we are going to
  // assume something random, because we have no clue, so generate a random
  // number between 0 - 70
  return Math.floor(Math.random() * 70);
};

/**
 * Release the connection from the connection pool.
 *
 * @param {Stream} net
 * @param {Boolean} hard destroySoon or destroy
 * @returns {Boolean} was the removal successful
 * @api private
 */

Manager.prototype.release = function release(net, hard) {
  var index = this.pool.indexOf(net);

  // no match
  if (index === -1) return false;

  // check if the stream is still open
  if (net) {
    if (!hard) net.destroySoon();
    else net.destroy();

    // remove it from the pool
    this.pool.splice(net, 1);

    // increase the releases metric
    this.metrics.releases++;
  }

  return true;
};

// alias remove to release
Manager.prototype.remove = Manager.prototype.release;

/**
 * Free dead connections from the pool.
 *
 * @param {Number} keep the amount of connection to keep open
 * @param {Boolean} hard destroy all connections instead of destroySoon
 * @api public
 */

Manager.prototype.free = function free(keep, hard) {
  // default to 0 if no arguments are supplied
  keep = +keep || 0;

  // create a back-up of the pool as we will be removing items from the array
  // and this could cause memory / socket leaks as we are unable to close some
  // connections in the array as the index has moved.
  var pool = this.pool.slice(0)
    , saved = 0;

  for (var i = 0, length = pool.length; i < length; i++) {
    var connection = pool[i]
      , probability = this.isAvailable(connection);

    // this is still a healthy connection, so try we probably just want to keep it
    if (keep && saved < keep && probability === 100) {
      saved++;
      continue;
    }

    this.release(connection, hard);
  }

  // clear the back-up
  pool.length = 0;

  // see how much connections are still available
  this.emit('free', saved, this.pool.length);
};

/**
 * Close the connection pool.
 *
 * @param {Boolean} hard destroy all connections
 * @api public
 */

Manager.prototype.end = function end(hard) {
  this.free(0, hard);

  return this.emit('end');
};

module.exports = Manager;

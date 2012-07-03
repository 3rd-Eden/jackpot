# whooohoo jackpot

[![build status](https://secure.travis-ci.org/3rd-Eden/jackpot.png)](http://travis-ci.org/3rd-Eden/jackpot)

Jackpot is a fault tolerant connection pool for Node.js, it automatically cleans
up after it self and detects broken connections. It does not need to be
released, as it will allocate connections based on their readyState / write
abilities.

## API

```js
var ConnectionPool = require('jackpot');

// first argument: size of the connection pool
// second argument: optional connection factory
var pool = new ConnectionPool(100);

// every connection pool requires a factory which is used to generate / setup
// the initial net.Connection
//
// it should return a new net.Connection instance..
pool.factory(function () {
  return net.connect(port, host)
});

// now that the pool is setup we can allocate a connection, the allocate
// requires a callback as it can be async..
pool.allocte(function (err, connection) {
  // error: when we failed to get a connection
  // connection: the allocated net.connection if there isn't an error
});

// call pool.free if you want to free connections from the pool, the arugment
// you supply is the amount of connections you want to keep
pool.free(10); // keep only 10 healthy connections kill the rest.

// kill the whole connection pool:
pool.end();
```

For more API information, fork this repo and add more.. or look at the test
file.

## LICENSE (MIT)

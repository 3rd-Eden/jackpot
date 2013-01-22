/*globals expect, TESTNUMBER, net */
describe('jackpot', function () {
  'use strict';

  var ConnectionPool = require('../')
    , port = TESTNUMBER
    , host = 'localhost'
    , server;

  before(function before(done) {
    server = net.createServer(function create(socket) {
      socket.write('<3');
    });

    server.listen(port, host, done);
  });

  it('should exported as a function', function () {
    expect(ConnectionPool).to.be.a('function');
  });

  it('should be an instance of EventEmitter', function () {
    expect(new ConnectionPool).to.be.instanceof(process.EventEmitter);
  });

  describe('initialize', function () {
    it('should update the limit if its supplied', function () {
      var pool = new ConnectionPool(100);

      expect(pool.limit).to.eql(100);
    });

    it('should also update the generator if its supplied', function () {
      function test() {}
      var pool = new ConnectionPool(100, test);

      expect(pool.generator).to.eql(test);
    });
  });

  describe('#factory', function () {
    it('should throw an error if the supplied factory is not a function', function () {
      var pool = new ConnectionPool();

      expect(pool.factory).to.throw(Error);
    });

    it('should not throw an error if a function is supplied', function () {
      var pool = new ConnectionPool();

      function test() {}
      expect(pool.factory.bind(pool, test)).to.not.throw(Error);
    });
  });

  describe('#allocate', function () {
    it('should give an error when no #factory is specified', function (done) {
      var pool = new ConnectionPool();

      pool.allocate(function allocate(err, conn) {
        expect(err).to.be.an.instanceof(Error);
        expect(err.message).to.contain('#factory');

        done();
      });
    });

    it('should emit an error when we cannot establish a connection', function (done) {
      var pool = new ConnectionPool()
        , differentport = TESTNUMBER;

      pool.once('error', function error(err) {
        expect(err).to.be.an.instanceof(Error);
      });

      pool.factory(function factory() {
        return net.connect(differentport, host);
      });

      // make sure the port is different
      expect(differentport).to.not.eql(port);

      pool.allocate(function allocate(err, connection) {
        expect(err).to.be.an.instanceof(Error);

        done();
      });
    });

    it('should NOT emit an error when we can establish a connection', function (done) {
      var pool = new ConnectionPool()
        , calls = 0;

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      function next() {
        if (++calls < 2) return;
        expect(server.connections).to.equal(1);

        pool.once('end', done);
        pool.end();
      }

      server.once('connection', next);

      pool.allocate(function allocate(err, connection) {
        expect(err).to.not.be.an.instanceof(Error);
        expect(connection).to.be.an.instanceof(net.Socket);
        expect(connection.readyState).to.equal('open');

        next();
      });
    });

    it('should an error occure, then remove it from the pool', function (done) {
      var pool = new ConnectionPool()
        , differentport = TESTNUMBER
        , connection;

      pool.once('error', function error(err) {
        expect(pool.pool).to.have.length(0);
        expect(connection.readyState).to.equal('closed');

        done();
      });

      pool.factory(function factory() {
        connection = net.connect(differentport, host);
        return connection;
      });

      // make sure the port is different
      expect(differentport).to.not.eql(port);

      pool.allocate(function allocate(err, connection) {});
    });

    it('should increase poolsize when a connection is allocated', function (done) {
      var pool = new ConnectionPool();

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      pool.allocate(function allocate(err, connection) {
        expect(connection).to.be.an.instanceof(net.Socket);
        expect(pool.pool).to.have.length(1);

        // make sure it also decreases when the connection is closed
        connection.on('end', function end() {
          expect(pool.pool).to.have.length(0);
          expect(server.connections).to.equal(0);

          done();
        });

        connection.end();
      });
    });

    it('should increase metrics when allocating a connection', function (done) {
      var pool = new ConnectionPool();

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      pool.allocate(function allocate(err, connection) {
        expect(pool.metrics.allocations).to.eql(1);
        expect(pool.metrics.releases).to.eql(0);

        // make sure it also decreases when the connection is closed
        connection.on('end', function end() {
          expect(pool.metrics.allocations).to.eql(1);
          expect(pool.metrics.releases).to.eql(1);

          done();
        });

        connection.end();
      });
    });

    it('should handle burst allocations', function (done) {
      var pool = new ConnectionPool(20)
        , connections = []
        , count = 0
        , allocations = 50;

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      /**
       * Small helper function.
       *
       * @param {error} err
       * @api private
       */

      function allocate(err, conn) {
        if (err) expect(err.message).to.equal('The connection pool is full');
        if (conn) connections.push(conn);
        if (++count !== allocations) return;

        expect(pool.pool).to.have.length(20);

        // free all the things
        pool.end(true);
        expect(pool.pending).to.eql(0);
        expect(pool.pool).to.have.length(0);
      }

      for (var i = 0; i < allocations; i++) {
        pool.allocate(allocate);
      }

      pool.once('free', function (saved) {
        expect(saved).to.eql(0);
      });

      pool.once('end', function () {
        connections.forEach(function (conn) {
          expect(conn.readyState).to.equal('closed');
        });

        done();
      });
    });
  });

  describe('#pull', function () {
    it('should give an error when no #factory is specified', function (done) {
      this.timeout(50000);

      var pool = new ConnectionPool();
      pool.retries = 1;

      pool.pull(function allocate(err, conn) {
        expect(err).to.be.an.instanceof(Error);
        expect(err.message).to.contain('#factory');

        done();
      });
    });

    it('should NOT emit an error when we can establish a connection', function (done) {
      var pool = new ConnectionPool();

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      pool.pull(function allocate(err, connection) {
        expect(err).to.not.be.an.instanceof(Error);
        expect(connection).to.be.an.instanceof(net.Socket);

        connection.end();
        done();
      });
    });

    it('should an error occure, then remove it from the pool', function (done) {
      var pool = new ConnectionPool()
        , differentport = TESTNUMBER;

      pool.once('error', function error(err) {
        expect(pool.pool).to.have.length(0);

        done();
      });

      pool.factory(function factory() {
        return net.connect(differentport, host);
      });

      // make sure the port is different
      expect(differentport).to.not.eql(port);

      pool.pull(function allocate(err, connection) {});
    });

    it('should increase poolsize when a connection is allocated', function (done) {
      var pool = new ConnectionPool();

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      pool.pull(function allocate(err, connection) {
        expect(connection).to.be.an.instanceof(net.Socket);
        expect(pool.pool).to.have.length(1);

        // make sure it also decreases when the connection is closed
        connection.on('end', function end() {
          expect(pool.pool).to.have.length(0);

          done();
        });
        connection.end();
      });
    });

    it('should increase metrics when allocating a connection', function (done) {
      var pool = new ConnectionPool();

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      pool.pull(function allocate(err, connection) {
        expect(pool.metrics.allocations).to.eql(1);

        // make sure it also decreases when the connection is closed
        connection.on('end', function end() {
          expect(pool.metrics.allocations).to.eql(1);
          expect(pool.metrics.releases).to.eql(1);

          done();
        });

        connection.end();
      });
    });
  });

  describe('#forEach', function () {
    it('should iterate over the items in the pool');
    it('should set the given context');
  });

  describe('#free', function () {
    it('should kill all connections when 0 is given', function (done) {
      var pool = new ConnectionPool();

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      pool.allocate(function allocate(err, connection) {
        expect(connection).to.be.an.instanceof(net.Socket);
        expect(pool.pool).to.have.length(1);

        pool.once('free', function free(saved, size) {
          expect(pool.pool).to.have.length(0);
          expect(size).to.eql(pool.pool.length);
          expect(saved).to.eql(0);

          done();
        });

        pool.free(0);
      });
    });

    it('should keep 1 connection', function (done) {
      var pool = new ConnectionPool();

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      pool.allocate(function allocate(err, connection) {
        expect(connection).to.be.an.instanceof(net.Socket);
        expect(pool.pool).to.have.length(1);

        pool.once('free', function free(saved, size) {
          expect(pool.pool).to.have.length(1);
          expect(size).to.eql(pool.pool.length);
          expect(saved).to.eql(1);

          connection.end();
          done();
        });

        pool.free(1);
      });
    });
  });

  describe('#release', function () {
    it('should only destroy matching connections');
    it('should softly kill the connection');
    it('should forcefully kill the connection');
    it('should increase the releases metric');
  });

  describe('#end', function () {
    it('should clear out the connection pool', function (done) {
      var connections = 20
        , pool = new ConnectionPool(connections)
        , allocated = 0;

      pool.factory(function factory() {
        return net.connect(port, host);
      });

      for (var i = 0; i < connections; i++) {
        pool.allocate(function allocating(err, conn) {
          if (err) return done(err);

          if (++allocated < connections) return;

          pool.once('close', function end() {
            expect(server.connections).to.equal(0);

            done();
          });

          pool.end();
        });
      }
    });

    it('should shutdown every established connection');
  });

  after(function after(done) {
    // in 0.7, we can supply the server with the done callback
    server.once('close', done);
    server.close();
  });
});

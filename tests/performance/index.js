/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const config = require('../../config'),
  models = require('../../models'),
  bcoin = require('bcoin'),
  Network = require('bcoin/lib/protocol/network'),
  network = Network.get(config.node.network),
  spawn = require('child_process').spawn,
  memwatch = require('memwatch-next'),
  expect = require('chai').expect,
  Promise = require('bluebird'),
  BlockModel = require('bcoin/lib/primitives/block'),
  SyncCacheService = require('../../services/syncCacheService'),
  BlockWatchingService = require('../../services/blockWatchingService'),
  providerService = require('../../services/providerService'),
  _ = require('lodash');

module.exports = (ctx) => {

  before(async () => {
    await models.blockModel.remove({});
    await models.txModel.remove({});
    await models.coinModel.remove({});
    await models.accountModel.remove({});
  });


  it('validate sync cache service performance', async () => {
    let keyring = new bcoin.keyring(ctx.keyPair, ctx.network);
    const instance = providerService.getConnectorFromURI(config.node.providers[0].uri);
    await instance.execute('generatetoaddress', [1000, keyring.getAddress().toString()]);

    let hd = new memwatch.HeapDiff();
    const syncCacheService = new SyncCacheService();
    await syncCacheService.start();
    await Promise.delay(60000);

    let diff = hd.end();
    let leakObjects = _.filter(diff.change.details, detail => detail.size_bytes / 1024 / 1024 > 3);

    expect(leakObjects.length).to.be.eq(0);
  });


  it('validate block watching service performance', async () => {
    let keyring = new bcoin.keyring(ctx.keyPair, ctx.network);
    const instance = providerService.getConnectorFromURI(config.node.providers[0].uri);

    let currentNodeHeight = await instance.execute('getblockcount', []);
    await instance.execute('generatetoaddress', [1000, keyring.getAddress().toString()]);

    let hd = new memwatch.HeapDiff();
    const blockWatchingService = new BlockWatchingService(currentNodeHeight);
    await blockWatchingService.startSync();
    await Promise.delay(20000);
    await blockWatchingService.stopSync();

    let diff = hd.end();
    let leakObjects = _.filter(diff.change.details, detail => detail.size_bytes / 1024 / 1024 > 3);

    expect(leakObjects.length).to.be.eq(0);
  });


  it('validate tx notification speed', async () => {
    let keyring = new bcoin.keyring(ctx.keyPair, ctx.network);
    ctx.blockProcessorPid = spawn('node', ['index.js'], {env: process.env, stdio: 'ignore'});
    await Promise.delay(10000);

    const instance = providerService.getConnectorFromURI(config.node.providers[0].uri);
    const address = keyring.getAddress().toString();
    await new models.accountModel({address}).save();

    let tx;
    let start;
    let end;

    await Promise.all([
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_performance.transaction`);
        await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test_performance.transaction`, 'events', `${config.rabbit.serviceName}_transaction.${address}`);
        await new Promise(res =>
          ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test_performance.transaction`, async data => {

            if(!data)
              return;

            const message = JSON.parse(data.content.toString());

            if (message.hash !== tx.txid())
              return;

            end = Date.now();
            await ctx.amqp.channel.deleteQueue(`app_${config.rabbit.serviceName}_test_performance.transaction`);
            res();

          }, {noAck: true})
        );
      })(),
      (async () => {

        let coins = await instance.execute('getcoinsbyaddress', [keyring.getAddress().toString()]);

        let inputCoins = _.chain(coins)
          .transform((result, coin) => {
            result.coins.push(bcoin.coin.fromJSON(coin));
            result.amount += coin.value;
          }, {amount: 0, coins: []})
          .value();

        const mtx = new bcoin.mtx();

        mtx.addOutput({
          address: keyring.getAddress(),
          value: Math.round(inputCoins.amount * 0.7)
        });

        await mtx.fund(inputCoins.coins, {
          rate: 10000,
          changeAddress: keyring.getAddress()
        });

        mtx.sign(keyring);
        tx = mtx.toTX();
        await instance.execute('sendrawtransaction', [tx.toRaw().toString('hex')]);
        start = Date.now();
      })()
    ]);

    await instance.execute('generatetoaddress', [1, keyring.getAddress().toString()]);
    expect(end - start).to.be.below(500);
    await Promise.delay(15000);
    ctx.blockProcessorPid.kill();
  });


  it('unconfirmed txs performance', async () => {

    let keyring = new bcoin.keyring(ctx.keyPair, ctx.network);
    const instance = providerService.getConnectorFromURI(config.node.providers[0].uri);

    let currentNodeHeight = await instance.execute('getblockcount', []);
    const blockWatchingService = new BlockWatchingService(currentNodeHeight);

    let txCount = await models.txModel.count();
    let blocks = await instance.execute('generatetoaddress', [10000, keyring.getAddress().toString()]);

    let hd = new memwatch.HeapDiff();
    let unconfirmedTxCount = 0;

    for (let blockHash of blocks) {
      let blockRaw = await instance.execute('getblock', [blockHash, false]);
      let block = BlockModel.fromRaw(blockRaw, 'hex').getJSON(network);

      if(block.txs.length > 1){
        console.log(block.txs);
        process.exit(0);
      }

      block.txs.forEach(tx => {
        unconfirmedTxCount++;
        blockWatchingService.unconfirmedTxEvent(tx.hex);
      });
    }

    await new Promise(res => {
      let pinInterval = setInterval(async () => {
        let newTxCount = await models.txModel.count();

        if (newTxCount !== txCount + unconfirmedTxCount)
          return;

        clearInterval(pinInterval);
        res();
      }, 3000);
    });

    let diff = hd.end();
    let leakObjects = _.filter(diff.change.details, detail => detail.size_bytes / 1024 / 1024 > 3);

    expect(leakObjects.length).to.be.eq(0);

  });


};

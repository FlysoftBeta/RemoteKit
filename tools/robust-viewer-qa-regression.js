// Load after robust-viewer-qa-browser.js. Functions execute only when explicitly called.
async (host) => {
  const qa = host._robustViewerQA;
  if (!qa) throw Error('Load robust-viewer-qa-browser.js first');
  const assert = (condition, message) => {
    if (!condition) throw Error(message);
  };
  qa.startSmoke = async () => {
    const page = qa.page;
    await qa.ready();
    if (await qa.uiCount({ css: 'button', text: '新建窗口' }))
      await qa.uiClick({ css: 'button', text: '新建窗口' });
    const start = await qa.sample('chrome' + qa.version + '-start');
    assert(
      start.state.workspace.tabs.length === 1 && start.state.workspace.tabs[0].kind === 'start',
      'Fresh account must have one explicit start tab',
    );
    assert(start.planes.length === 0, 'Start page must not create remote video plane');
    const connection = start.connectionId,
      peerCount = start.peerCount;
    await qa.uiFill(
      { css: 'input[aria-label="搜索或输入网址"]', index: 'last' },
      'http://127.0.0.1:' + qa.fixturePort + '/?label=A&中文=输入',
    );
    await qa.uiClick({ css: 'button[aria-label="搜索或打开"]' });
    await page.waitForFunction(() =>
      robustQA.state.workspace.tabs.some((tab) => tab.kind === 'remote' && tab.url.includes('label=A')),
    );
    await qa.ready();
    await page.waitForFunction(() => robustQA.transport().videoPlanes.size === 1);
    let observed;
    for (let n = 0; n < 30; n++) {
      observed = await qa.inspect();
      if (observed.events.some((event) => event.type === 'ready' && event.label === 'A')) break;
      await page.waitForTimeout(100);
    }
    assert(
      observed.events.some(
        (event) => event.type === 'ready' && event.href.includes(encodeURIComponent('中文')),
      ),
      'Remote DOM did not confirm encoded Unicode URL',
    );
    const remote = await qa.sample('chrome' + qa.version + '-first-remote');
    assert(
      remote.connectionId === connection && remote.peerCount === peerCount,
      'Start to remote rebuilt PeerConnection',
    );
    assert(remote.mstp === 0, 'Default video unexpectedly started MSTP');
    await qa.assertNoWsActions();
    return {
      start: { connectionId: connection, peerCount },
      remote: { connectionId: remote.connectionId, peerCount: remote.peerCount, planes: remote.planes },
    };
  };
  qa.reliability = async () => {
    const page = qa.page;
    await qa.ready();
    const baseline = await page.evaluate(() => ({
      count: robustQA.state.workspace.tabs.length,
      ws: robustQA.wsSent.length,
    }));
    await page.evaluate(() => {
      robustQA.dropProductReplies = 1;
    });
    await qa.uiClick({ css: 'button[aria-label="新建标签页"]' });
    await page.waitForFunction((count) => robustQA.state.workspace.tabs.length === count + 1, baseline.count);
    const operation = await page.evaluate(
      () =>
        robustQA.dcSent
          .filter((message) => message.type === 'product.action' && message.action.type === 'tab.create')
          .slice(-1)[0],
    );
    assert(operation, 'UI did not send create-tab through DC');
    const receipt = await page.evaluate(
      (operation) =>
        robustQA.rpc('operation.status', {
          operationId: operation.operationId,
          operationGeneration: operation.operationGeneration,
        }),
      operation,
    );
    assert(receipt.status === 'committed', 'Lost reply did not have a durable committed receipt');
    await page.evaluate(
      (operation) => robustQA.channels[robustQA.channels.length - 1].qaRawSend(JSON.stringify(operation)),
      operation,
    );
    await page.waitForTimeout(250);
    assert(
      (await page.evaluate(() => robustQA.state.workspace.tabs.length)) === baseline.count + 1,
      'Duplicate operation created another tab',
    );
    const prior = await page.evaluate(() => robustQA.snapshots.slice(-1)[0]);
    await page.evaluate(() => {
      robustQA.holdSnapshots = true;
      robustQA.heldSnapshots = [];
    });
    await qa.uiClick({ css: 'button[aria-label="新建标签页"]' });
    await page.waitForFunction(() =>
      robustQA.heldSnapshots.some(
        (message) => message.state.workspace.tabs.length >= robustQA.state.workspace.tabs.length + 1,
      ),
    );
    const released = await page.evaluate((prior) => {
      const q = robustQA,
        newest = q.heldSnapshots.slice(-1)[0];
      q.holdSnapshots = false;
      q.heldSnapshots = [];
      q.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(newest) }));
      q.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(prior) }));
      return { sequence: newest.state.snapshotSequence, count: newest.state.workspace.tabs.length };
    }, prior);
    await page.waitForTimeout(100);
    const rendered = await qa.uiCount({ css: '[role="tab"]' });
    assert(rendered === released.count, 'Older snapshot rolled UI tab count backward');
    await qa.assertNoWsActions();
    const evidence = await qa.sample('chrome' + qa.version + '-receipt-snapshot');
    return {
      receipt,
      operationId: operation.operationId,
      released,
      rendered,
      connectionId: evidence.connectionId,
    };
  };
  qa.managementReconnect = async () => {
    const before = await qa.sample('chrome' + qa.version + '-before-management-drop');
    const response = await qa.page.request.post(
      'http://127.0.0.1:' + qa.fixturePort + '/management-disconnect',
    );
    assert(response.ok(), 'WinHTTP fixture node mode required');
    await qa.page.waitForTimeout(1800);
    await qa.ready();
    const after = await qa.sample('chrome' + qa.version + '-after-management-drop');
    assert(
      before.connectionId === after.connectionId && before.peerCount === after.peerCount,
      'Management reconnect rebuilt RTC',
    );
    assert(
      JSON.stringify(before.planes.map((p) => [p.videoId, p.streamId, p.tracks])) ===
        JSON.stringify(after.planes.map((p) => [p.videoId, p.streamId, p.tracks])),
      'Management reconnect rebuilt media elements/tracks',
    );
    return {
      before: { connectionId: before.connectionId, peerCount: before.peerCount },
      after: { connectionId: after.connectionId, peerCount: after.peerCount },
    };
  };
  return { prepared: true, started: false, groups: ['startSmoke', 'reliability', 'managementReconnect'] };
};

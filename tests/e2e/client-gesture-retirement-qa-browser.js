async (host) => {
  const qa = host._clientGestureQA;
  const base = qa.base;
  const assert = (value, message) => {
    if (!value) throw Error(message);
  };
  const root = (e) => e.common.fixture.telemetry[e.case + ':root'];
  const quickTap = () =>
    qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 120, y: 110 }] },
        { at: 40, type: 'touchEnd', points: [] },
      ],
      { settleMs: 80 },
    );
  const ready = async () => {
    await base.ready();
    await base.page.waitForFunction((id) => !!robustQA.transport().presentation.canInput(id), qa.viewId);
  };
  const recover = async (id, clicks) => {
    await ready();
    await quickTap();
    await base.page.waitForTimeout(300);
    const tap = await qa.sample(id + '-tap');
    assert(root(tap).clicks === clicks, 'Recovery tap missing or duplicated');
    const before = root(tap).positions.rootY;
    await qa.swipe();
    const scroll = await qa.sample(id + '-scroll');
    assert(root(scroll).positions.rootY > before + 100, 'Recovery scroll did not advance');
    assert(root(scroll).clicks === clicks, 'Scroll generated an extra click');
    assert(
      scroll.data.sent.every(({ message }) => !message.type.startsWith('input.')),
      'Touch sent an auxiliary control message',
    );
    return [tap.summary, scroll.summary];
  };
  const cases = (host._retirementQA = {});
  cases.rapidSuccessive = async () => {
    const id = `v${base.version}-successive-${Date.now()}`;
    await qa.navigate({ id });
    await qa.holdInputResults(true);
    for (let i = 0; i < 6; ++i) await quickTap();
    await base.page.waitForTimeout(400);
    const held = await qa.sample(id + '-held');
    assert(root(held).clicks === 6, 'Held input results blocked or duplicated taps');
    const starts = held.data.sent.filter(
      ({ message }) => message.event?.type === 'touch' && message.event.action === 'start',
    );
    assert(
      starts.length === 6 && new Set(starts.map(({ message }) => message.event.sequenceId)).size === 6,
      'Successive touches did not get distinct sequences',
    );
    await qa.releaseInputResults();
    await base.page.waitForTimeout(300);
    const late = await qa.sample(id + '-late');
    assert(root(late).clicks === 6, 'Late results replayed a click');
    return [held.summary, late.summary, ...(await recover(id, 7))];
  };
  cases.activeContacts = async () => {
    const id = `v${base.version}-supersede-active-${Date.now()}`;
    await qa.navigate({ id });
    await base.page.evaluate(() => {
      clientGestureQA.dropNextEnd = true;
    });
    await quickTap();
    await base.page.waitForTimeout(200);
    const abandoned = await qa.sample(id + '-abandoned');
    assert(root(abandoned).clicks === 0, 'Abandoned start generated a click');
    await quickTap();
    await base.page.waitForTimeout(300);
    const replaced = await qa.sample(id + '-replaced');
    assert(root(replaced).counts.touchcancel === 1, 'Superseding did not emit exactly one raw cancel');
    assert(root(replaced).clicks === 1, 'New start failed or duplicated the abandoned tap');
    return [replaced.summary, ...(await recover(id, 2))];
  };
  cases.pendingTerminal = async () => {
    const id = `v${base.version}-pending-terminal-${Date.now()}`;
    // Keep both terminals pending within the ACK deadline. Timeout recovery is
    // exercised separately below; it deliberately stops gesture arbitration.
    await qa.navigate({ id, block: 'ackpending' });
    await qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 120, y: 110 }] },
        { at: 50, type: 'touchEnd', points: [] },
      ],
      { settleMs: 0 },
    );
    await quickTap();
    await base.page.waitForTimeout(1800);
    const replaced = await qa.sample(id + '-replaced');
    assert(!root(replaced).counts.touchcancel, 'Queued terminal received an extra cancel');
    assert(root(replaced).clicks === 2, 'Queued terminal or successive tap failed or duplicated');
    return [replaced.summary, ...(await recover(id, 3))];
  };
  cases.rawAckTimeout = async () => {
    const id = `v${base.version}-ack-timeout-${Date.now()}`;
    await qa.navigate({ id, block: 'ackdelay' });
    await qa.touch('touchStart', [{ x: 820, y: 110 }]);
    await base.page.evaluate(() => clientGestureQA.tail);
    await base.page.waitForTimeout(2300);
    await base.page.evaluate(() => {
      clientGestureQA.dropNextEnd = true;
    });
    await qa.touch('touchEnd', []);
    await base.page.evaluate(() => clientGestureQA.tail);
    return recover(id, 1);
  };
  cases.layout = async () => {
    const id = `v${base.version}-resize-gesture-${Date.now()}`;
    await qa.navigate({ id });
    await qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 120, y: 650 }] },
        { at: 40, type: 'touchMove', points: [{ x: 120, y: 610 }] },
      ],
      { settleMs: 100 },
    );
    const size = base.page.viewportSize();
    const oldEpoch = await base.page.evaluate(() => robustQA.transport().presentation.layout.epoch);
    await base.page.setViewportSize({ width: size.width + 37, height: size.height });
    await base.page.waitForFunction(
      (old) => robustQA.transport().presentation.layout.epoch !== old,
      oldEpoch,
    );
    await ready();
    await qa.touch('touchEnd', []);
    const result = await recover(id, 1);
    await base.page.setViewportSize(size);
    await ready();
    return result;
  };
  cases.targetloss = async () => {
    const id = `v${base.version}-target-removal-${Date.now()}`;
    await qa.navigate({ id, live: true });
    await qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 400, y: 500 }] },
        { at: 40, type: 'touchMove', points: [{ x: 400, y: 470 }] },
        { at: 80, type: 'touchMove', points: [{ x: 400, y: 440 }] },
      ],
      { settleMs: 200 },
    );
    const before = await qa.sample(id + '-before');
    assert(
      before.common.fixture.telemetry[id + ':child']?.counts.touchstart,
      'Child did not own raw touch before removal',
    );
    const response = await base.page.request.post(`http://127.0.0.1:${base.fixturePort}/command?id=${id}`, {
      data: { type: 'remove-child' },
    });
    assert(response.ok(), 'Target removal command failed');
    let removed = false;
    for (let i = 0; i < 40; ++i) {
      if (
        (await base.inspect()).telemetry[id + ':root']?.events.some((e) => e.type === 'fixture-remove-child')
      ) {
        removed = true;
        break;
      }
      await base.page.waitForTimeout(50);
    }
    assert(removed, 'Target removal was not observed');
    await qa.touch('touchMove', [{ x: 400, y: 420 }]);
    await qa.touch('touchEnd', []);
    await base.page.waitForTimeout(300);
    const removedState = await qa.sample(id + '-removed');
    assert(
      !root(removedState).counts.touchstart && !root(removedState).counts.touchmove,
      'Old coordinates reached the replacement target',
    );
    return recover(id, 1);
  };
  cases.document = async () => {
    const id = `v${base.version}-document-gesture-${Date.now()}`;
    await qa.navigate({ id: id + '-old' });
    await qa.touch('touchStart', [{ x: 120, y: 650 }]);
    await qa.navigate({ id: id + '-new' });
    await qa.touch('touchEnd', []);
    return recover(id, 1);
  };
  return { prepared: true, cases: Object.keys(cases) };
};

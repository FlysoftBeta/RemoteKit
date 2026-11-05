export type ControlRpc = (
  method: 'rtc.offer' | 'rtc.ice' | 'rtc.close' | 'clock.ping' | 'feedback',
  params: unknown,
) => Promise<unknown>;

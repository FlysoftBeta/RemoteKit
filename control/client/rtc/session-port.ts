export type ControlRpc = (
  method:
    | 'rtc.offer'
    | 'rtc.ice'
    | 'rtc.close'
    | 'service.offer'
    | 'service.ice'
    | 'service.close'
    | 'clock.ping'
    | 'feedback',
  params: unknown,
) => Promise<unknown>;

export type ControlRpc = (
  method:
    | 'rtc.offer'
    | 'rtc.offerStatus'
    | 'rtc.ice'
    | 'rtc.close'
    | 'service.offer'
    | 'service.offerStatus'
    | 'service.ice'
    | 'service.close'
    | 'clock.ping'
    | 'feedback',
  params: unknown,
) => Promise<unknown>;

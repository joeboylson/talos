// For times that stay inside the server and are only compared with each other
// (a ping's wait, when a page's check began vs a sign-out): like Date.now() when
// the server starts, but it only moves forward, so a clock jumping back can't
// stretch a wait or let a page in after a sign-out.
export const steadyNow = (): number => performance.timeOrigin + performance.now();

// Claude also stores image companions and other internal notes as role=user.
// They remain in the raw trace but never start a new human prompt/round.
export const isNativeUserMessage = (event) =>
  event?.type === 'user' &&
  !event.isSidechain &&
  !event.isMeta &&
  !event.turnCompanion &&
  typeof event.message?.content === 'string';

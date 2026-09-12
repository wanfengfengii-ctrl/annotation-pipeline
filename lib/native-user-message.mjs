// Claude also stores image companions and other internal notes as role=user.
// They remain in the raw trace but never start a new human prompt/round.
export const isNativeUserMessage = (event) =>
  event?.type === 'user' &&
  !event.isSidechain &&
  !event.isMeta &&
  !event.turnCompanion &&
  typeof event.message?.content === 'string';

// Terminal paste may record one final LF or one existing leading ASCII space.
// Do not trim arbitrary whitespace or normalize any part of the requirement.
// This is a transport
// comparison only; retain both the sent digest and native bytes unchanged.
export const nativePromptMatches = (actual, sent) =>
  typeof sent === 'string' &&
  (actual === sent || actual === sent + '\n' || actual === ' ' + sent);

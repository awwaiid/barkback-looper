// Max recording duration per track. Used by both the worklet (as fallback
// buffer size if pre-allocation hasn't arrived yet) and the main-thread
// engine (to pre-allocate transferable recording buffers).
export const MAX_RECORDING_SECONDS = 600;

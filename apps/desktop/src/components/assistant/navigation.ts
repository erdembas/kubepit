import { createContext, useContext } from 'react';

/** Reveal editor/settings destinations while keeping the live assistant mounted. */
export const AssistantNavigationContext = createContext<() => void>(() => {});
export const useAssistantNavigation = () => useContext(AssistantNavigationContext);

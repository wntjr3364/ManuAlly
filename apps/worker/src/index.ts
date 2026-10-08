// Worker entry. P01 has no job processing yet (PW-013 adds the queue); provider selection is
// centralised in @pw/providers so that tests and the worker share the same admission rule.
export { selectProvider } from '@pw/providers';

import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * Stands up an in-memory tracer for a test.
 *
 * The context manager is the part that is easy to forget and expensive to
 * omit: a BasicTracerProvider on its own leaves the global NoopContextManager
 * in place, so startActiveSpan creates spans that are never parents of
 * anything and trace ids are invisible to the code under test. Production
 * registers AsyncLocalStorageContextManager via NodeSDK.start(), so
 * registering it here is what makes these tests resemble production rather
 * than a weaker version of it.
 */
export function startTestTracing(): {
  exporter: InMemorySpanExporter;
  stop: () => void;
} {
  const exporter = new InMemorySpanExporter();
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);

  return {
    exporter,
    stop: () => {
      contextManager.disable();
      context.disable();
      trace.disable();
    },
  };
}

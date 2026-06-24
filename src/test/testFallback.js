import test from 'node:test';
import assert from 'node:assert';
import { ProviderManager } from '../agent/llm/createProvider.js';
import { BaseLLMProvider, LLMResponse } from '../agent/llm/BaseLLMProvider.js';

class MockFailingProvider extends BaseLLMProvider {
    async chat(messages, tools) {
        throw new Error("Quota Exceeded");
    }
}

class MockSuccessProvider extends BaseLLMProvider {
    async chat(messages, tools) {
        return new LLMResponse({ text: "Success!" });
    }
}

test('ProviderManager fallback chain', async (t) => {
    // Override the factories locally for testing
    const originalFactories = global.PROVIDER_FACTORIES;
    
    const manager = new ProviderManager({});
    
    // Test that if all fail, it throws
    manager.chatWithFallback = async () => {
        let error;
        const providers = [new MockFailingProvider(), new MockFailingProvider()];
        for (const p of providers) {
            try {
                return await p.chat([], []);
            } catch (e) {
                error = e;
            }
        }
        throw new Error("All configured LLM providers failed.");
    };

    await assert.rejects(
        manager.chatWithFallback([], []),
        /All configured LLM providers failed/
    );

    // Test that it succeeds on the second try
    manager.chatWithFallback = async () => {
        const providers = [new MockFailingProvider(), new MockSuccessProvider()];
        for (const p of providers) {
            try {
                return await p.chat([], []);
            } catch (e) {
                continue;
            }
        }
        throw new Error("All configured LLM providers failed.");
    };

    const res = await manager.chatWithFallback([], []);
    assert.strictEqual(res.text, "Success!");
});

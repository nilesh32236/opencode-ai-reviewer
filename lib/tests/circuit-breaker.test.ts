import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.getState()).toBe('CLOSED');
  });

  it('calls the function and returns result on success', async () => {
    const cb = new CircuitBreaker({ name: 'test' });
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await cb.call(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('transitions to OPEN after failureThreshold failures', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10000,
      name: 'test',
    });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(fn)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('CLOSED');

    await expect(cb.call(fn)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');
  });

  it('rejects immediately when circuit is OPEN', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5000,
      name: 'test',
    });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(fn)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');

    const successFn = vi.fn().mockResolvedValue('ok');
    await expect(cb.call(successFn)).rejects.toThrow('Circuit is OPEN');
    expect(successFn).not.toHaveBeenCalled();
  });

  it('transitions to HALF_OPEN after cooldown period', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      name: 'test',
    });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(fn)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('transitions back to CLOSED after successThreshold successes in HALF_OPEN', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      cooldownMs: 10,
      name: 'test',
    });
    const failFn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(failFn)).rejects.toThrow('fail');

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cb.getState()).toBe('HALF_OPEN');

    const successFn = vi.fn().mockResolvedValue('ok');
    await cb.call(successFn);
    expect(cb.getState()).toBe('HALF_OPEN');

    await cb.call(successFn);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('transitions back to OPEN on failure in HALF_OPEN state', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 1,
      cooldownMs: 10,
      name: 'test',
    });
    const failFn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(cb.call(failFn)).rejects.toThrow('fail');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cb.getState()).toBe('HALF_OPEN');

    await expect(cb.call(failFn)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');
  });

  it('returns metrics correctly', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    const metrics = cb.getMetrics();
    expect(metrics.state).toBe('CLOSED');
    expect(metrics.failureCount).toBe(0);
    expect(metrics.successCount).toBe(0);
  });

  it('reset brings circuit back to CLOSED', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      name: 'test',
    });

    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(cb.call(fn)).rejects.toThrow('fail');

    expect(cb.getState()).toBe('OPEN');
    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
  });
});

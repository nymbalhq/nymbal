import { css } from 'lit'

/** The primary and secondary buttons the page views render, from the same tokens the templates' `.btn` reads. */
export const buttonStyles = css`
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--nymbal-spacing-xs, 0.25rem);
    padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
    font-family: inherit;
    font-size: var(--nymbal-font-size-sm, 0.875rem);
    font-weight: var(--nymbal-font-weight-medium, 500);
    line-height: 1.4;
    text-decoration: none;
    border: 1px solid transparent;
    border-radius: var(--nymbal-radius-md, 0.5rem);
    cursor: pointer;
    transition:
      background-color var(--nymbal-transition-fast, 150ms) ease,
      border-color var(--nymbal-transition-fast, 150ms) ease;
  }
  .btn:focus-visible {
    outline: 2px solid var(--nymbal-color-accent, #2563eb);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-primary {
    background-color: var(--nymbal-color-primary, #18181b);
    color: var(--nymbal-color-text-inverse, #ffffff);
    border-color: var(--nymbal-color-primary, #18181b);
  }
  .btn-primary:hover {
    background-color: var(--nymbal-color-primary-hover, #27272a);
  }
  .btn-secondary {
    background-color: transparent;
    color: var(--nymbal-color-primary, #18181b);
    border-color: var(--nymbal-color-border, #e4e4e7);
  }
  .btn-secondary:hover {
    background-color: var(--nymbal-color-border, #e4e4e7);
  }
`

/** Labelled fields, error and notice text, as the templates' `.form-group` styled them. */
export const fieldStyles = css`
  :host {
    display: block;
    font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
    color: var(--nymbal-color-text, #18181b);
  }
  [part~='field'] {
    margin-bottom: var(--nymbal-spacing-md, 1rem);
  }
  [part~='label'] {
    display: block;
    font-size: var(--nymbal-font-size-sm, 0.875rem);
    font-weight: var(--nymbal-font-weight-medium, 500);
    margin-bottom: var(--nymbal-spacing-xs, 0.25rem);
  }
  [part~='input'] {
    display: block;
    width: 100%;
    padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
    font: inherit;
    font-size: var(--nymbal-font-size-sm, 0.875rem);
    line-height: 1.5;
    color: var(--nymbal-color-text, #18181b);
    background-color: var(--nymbal-color-surface, #ffffff);
    border: 1px solid var(--nymbal-color-border, #e4e4e7);
    border-radius: var(--nymbal-radius-md, 0.5rem);
  }
  [part~='input']:focus {
    outline: none;
    border-color: var(--nymbal-color-accent, #2563eb);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
  }
  [part~='input']:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  [part~='error'] {
    margin-bottom: var(--nymbal-spacing-md, 1rem);
    padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
    font-size: var(--nymbal-font-size-sm, 0.875rem);
    color: var(--nymbal-color-error, #dc2626);
    background: #fef2f2;
    border: 1px solid var(--nymbal-color-error, #dc2626);
    border-radius: var(--nymbal-radius-md, 0.5rem);
  }
  [part~='message'] {
    margin-top: var(--nymbal-spacing-md, 1rem);
    font-size: var(--nymbal-font-size-sm, 0.875rem);
    color: var(--nymbal-color-success, #16a34a);
  }
  [part~='submit'] {
    width: 100%;
    margin-top: var(--nymbal-spacing-sm, 0.5rem);
  }
`

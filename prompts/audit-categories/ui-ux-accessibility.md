# Audit: UI/UX & Accessibility

You are auditing user interface quality and accessibility compliance. Focus on WCAG standards and responsive design.

## What to Check

### Accessibility (WCAG)
- Interactive elements have `aria-label` or associated labels
- Focus indicators visible for all interactive elements
- Color contrast meets WCAG AA (4.5:1 for text)
- Keyboard navigation works (tab order, enter/space activation)
- Screen reader announcements for dynamic content

### Responsive Design
- Layout adapts across breakpoints
- Touch targets at least 44x44px
- No horizontal overflow on small screens
- Font size legible at 16px minimum

### Form UX
- Loading states during submission
- Field-level error messages displayed inline
- Successful actions confirmed via feedback
- Form input preserved on validation error

### Dark Mode & Theming
- All colors defined for both themes
- No raw hex colors (use CSS variables/tokens)
- Theme toggle works without page flicker

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Keyboard trap, missing focus indicator, no form error feedback
- **important**: Small touch targets, missing aria-labels, no loading state
- **minor**: Suboptimal contrast, redundant ARIA, inconsistent spacing
Common Sense Guidelines for React Developers
These are shared practices meant to help the team write clean, consistent, and maintainable React code. While not strict rules, they reflect practical experience and good habits.

1. Think in Components
Break down the UI into small, reusable, and testable components.
Follow the Single Responsibility Principle — each component should have one purpose.
Avoid large, monolithic components that try to handle everything.

2. Use Clear and Descriptive Naming
Choose meaningful names for components, functions, variables, and files.
Avoid abbreviations and single-letter names (except for loop counters).
Component names should use PascalCase; variables and functions should use camelCase.

3. Follow a Consistent Project Structure
Group related files (components, hooks, tests, styles) together.
Keep folder and file structures logical and shallow where possible.
Be consistent with casing and naming patterns across the codebase.

4. Keep JSX Readable
Avoid deeply nested JSX trees.
Extract repeated logic and large JSX blocks into smaller components.
Use conditional rendering sparingly and clearly.

5. Manage State Thoughtfully
Use local state (useState) where possible.
Use context or external state management only when the state is shared across many components.
Avoid prop drilling by lifting state or using context appropriately.

6. Use Custom Hooks for Reusable Logic
Extract shared behavior into custom hooks instead of repeating code.
Name hooks clearly and consistently (e.g., useAuth, useUserPermissions).

7. Handle Side Effects Properly
Use useEffect for side effects like API calls, subscriptions, and DOM manipulations.
Always clean up effects when necessary (e.g., removing event listeners, canceling timers).

8. Avoid Inline Functions in JSX
Extract handlers and logic outside the render body to avoid unnecessary re-renders.
This improves readability and performance.

9. Keep Styling Consistent and Modular
Use a consistent styling approach (e.g., Tailwind CSS, CSS Modules, styled-components).
Avoid inline styles except for quick, one-off use.
Keep styles colocated with their components when appropriate.

10. Write Tests That Add Value
Test important logic, not just render output.
Focus on testing business rules and user interactions.
Avoid testing third-party libraries or trivial code.

11. Consider Accessibility from the Start
Use semantic HTML elements and attributes.
Include proper aria labels and roles when needed.
Ensure keyboard navigation and screen reader support.

12. Use Clear and Frequent Commits
Write descriptive commit messages.
Commit logically grouped changes together.
Follow team or project conventions (e.g., Conventional Commits).

13. Communicate and Document
Ask for help or clarification when blocked or unsure.
Document non-obvious logic or decisions.
Share learnings with the team through documentation or communication channels.


/**
   * JobRunner stores successful step outputs using the step ID:
   * context[stepId] = output;
   
   * REST definitions are JSON and cannot read context. This resolver provides a small template syntax:
   
   * "{{login.data.user}}"         -> preserves the original value/type
   * "Bearer {{login.data.token}}" -> embeds a scalar value into a string
   
   * Templates do not create execution dependencies. A referenced step must
   * still be declared in DEPENDS_ON so its output is guaranteed to exist.
   
   * !!!!
   * Context paths use dots as separators, so step IDs referenced by templates should not contain dots.
   
*/

  // Matches only when the entire string is one template.
  // Exact templates preserve objects, arrays, numbers, booleans, and null.
const EXACT_TEMPLATE_PATTERN =
    /^\{\{\s*([^{}]+?)\s*\}\}$/;
// Finds templates inside a larger string.
// The "g" flag replaces every matching template in that string.
const TEMPLATE_PATTERN =
    /\{\{\s*([^{}]+?)\s*\}\}/g;
// Prevent access to JavaScript prototype-related properties.
const FORBIDDEN_PATH_SEGMENTS = new Set([
    '__proto__',
    'prototype',
    'constructor'
]);
export interface ContextResolutionOptions {
    /**
     * REST steps should pass their DEPENDS_ON values here.
     * This prevents a step from consuming context that is not guaranteed
     * to be ready.
     */
    allowedStepIds?: ReadonlySet<string>;
}

/**
 * Recursively resolves templates in strings, arrays, and objects.
 *
 * The input is treated as a request template and is not mutated.
 * Primitive values that do not contain templates are returned unchanged.
 */
export function resolveContextTemplates<T>(
    value: T,
    context: Record<string, unknown>,
    options: ContextResolutionOptions = {}
): T {
    return resolveValue(value, context, options) as T;
}

function resolveValue(
    value: unknown,
    context: Record<string, unknown>,
    options: ContextResolutionOptions
): unknown {
    if (typeof value === 'string') {
        return resolveString(value, context, options);
    }
    if (Array.isArray(value)) {
        return value.map(item =>
            resolveValue(item, context, options)
        );
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nestedValue]) => [
                key,
                resolveValue(nestedValue, context, options)
            ])
        );
    }
    // Numbers, booleans, null, and other non-template values
    // do not need any transformation.
    return value;
}

function resolveString(
    template: string,
    context: Record<string, unknown>,
    options: ContextResolutionOptions
): unknown {
    const exactMatch = template.match(EXACT_TEMPLATE_PATTERN);
    const exactPath = exactMatch?.[1];
    /**
     * If the entire string is a template, return the original value.
     *
     * For example:
     * "{{login.data.user}}" -> { id: 42, name: "Yavuz" }
     *
     * Returning the original value prevents objects from becoming
     * the string "[object Object]".
     */
    if (exactPath) {
        return resolveContextPath(exactPath, context, options);
    }
    /**
     * Embedded templates must become part of a string.
     *
     * For example:
     * "Bearer {{login.data.token}}" -> "Bearer abc123"
     */
    return template.replace(
        TEMPLATE_PATTERN,
        (_match: string, rawPath: string) => {
            const resolvedValue = resolveContextPath(
                rawPath,
                context,
                options
            );
            /**
             * Objects and arrays cannot be meaningfully embedded in a string.
             * They must be used as an exact template instead.
             */
            if (
                resolvedValue !== null &&
                (
                    typeof resolvedValue === 'object' ||
                    typeof resolvedValue === 'function' ||
                    typeof resolvedValue === 'symbol'
                )
            ) {
                throw new Error(
                    `Context path "${rawPath.trim()}" cannot be embedded ` +
                    'inside a string. Use it as the entire value instead.'
                );
            }
            return String(resolvedValue);
        }
    );
}

/**
    * Resolves a dot-separated path by walking through the context object.
    *
    * Example:
    * "login.data.user.id"
    *
    * becomes:
    * context["login"]["data"]["user"]["id"]
    *
    * Numeric array indexes also work:
    * "users.data.results.0.email"
*/
function resolveContextPath(
    rawPath: string,
    context: Record<string, unknown>,
    options: ContextResolutionOptions
  ): unknown {
  const pathSegments = rawPath
    .trim()
    .split('.')
    .map(segment => segment.trim());
  if (
    pathSegments.length === 0 ||
    pathSegments.some(segment => segment.length === 0)
  ) {
    throw new Error(`Invalid context path: "${rawPath.trim()}".`);
  }
  for (const segment of pathSegments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
        throw new Error(
            `Unsafe context path segment: "${segment}".`
        );
    }
  }
  // The first path segment is always the ID of the referenced step.
  const stepId = pathSegments[0];
  if (!stepId) {
      throw new Error(`Invalid context path: "${rawPath.trim()}".`);
  }
  /**
   * A template is not a substitute for DEPENDS_ON.
   *
   * Without this check, a REST step could accidentally rely on an
   * independent step whose output is not guaranteed to be available.
   */
  if (
      options.allowedStepIds &&
      !options.allowedStepIds.has(stepId)
  ) {
      throw new Error(
          `Step "${stepId}" must be declared in DEPENDS_ON ` +
          'before its context can be used.'
      );
  }
  let currentValue: unknown = context;
  for (const segment of pathSegments) {
      /**
       * hasOwnProperty prevents traversal through inherited/prototype
       * properties and also gives a clear error for missing paths.
       */
      if (
          currentValue === null ||
          typeof currentValue !== 'object' ||
          !Object.prototype.hasOwnProperty.call(currentValue, segment)
      ) {
          throw new Error(
              `Context path "${rawPath.trim()}" could not be resolved ` +
              `at segment "${segment}".`
          );
      }
      currentValue = (
          currentValue as Record<string, unknown>
      )[segment];
  }
  if (currentValue === undefined) {
      throw new Error(
          `Context path "${rawPath.trim()}" resolved to undefined.`
      );
  }
  return currentValue;
}

/**
 * Arrays are handled separately because they need to preserve their order.
 * This check identifies ordinary nested request objects.
*/
function isRecord(
    value: unknown
): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}
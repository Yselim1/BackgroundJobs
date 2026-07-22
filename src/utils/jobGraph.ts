export interface DependencyNode {
    id: string;
    dependsOn: readonly string[];
}

/**
   * Searches the dependency graph for a cycle.
   *
   * Example:
   *
   * step-a -> step-b -> step-c -> step-a
   *
   * Returns the complete cycle path when found. Returns undefined when
   * the graph is acyclic.
   */
export function findDependencyCycle(nodes: readonly DependencyNode[]): string[] | undefined {
    const nodesById = new Map(
        nodes.map(node => [node.id, node])
    );

    const states = new Map<string,'visiting' | 'visited'>();

    const currentPath: string[] = [];

    function visit(nodeId: string): string[] | undefined {
        states.set(nodeId, 'visiting');
        currentPath.push(nodeId);

        const node = nodesById.get(nodeId);

        for (const dependencyId of node?.dependsOn ?? []) {
            // Missing and self dependencies are reported separately by
            // jobValidator, so they are ignored during cycle traversal.
            if (dependencyId === nodeId || !nodesById.has(dependencyId)) continue;

            const dependencyState = states.get(dependencyId);

            if (dependencyState === 'visiting') {
                const cycleStartIndex =
                currentPath.lastIndexOf(dependencyId);

                return [...currentPath.slice(cycleStartIndex), dependencyId];
            }

            if (dependencyState === undefined) {
                const cycle = visit(dependencyId);
                if (cycle !== undefined) return cycle;
            }
        }

        currentPath.pop();
        states.set(nodeId, 'visited');

        return undefined;
    }

    for (const node of nodes) {
        if (states.has(node.id)) continue;

        const cycle = visit(node.id);

        if (cycle !== undefined) return cycle;
    }

    return undefined;
}
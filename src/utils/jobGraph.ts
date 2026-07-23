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

/**
   * Groups dependency nodes into executable levels.
   *
   * Nodes in the same level have all their dependencies completed before
   * that level begins, so they can be considered runnable together.
   *
   * The input order is preserved where possible. JobService will provide
   * nodes sorted by step ORDER.
   *
   * Example:
   *
   * step-a
   * step-b
   * step-c depends on step-a
   * step-d depends on step-a and step-b
   *
   * Result:
   *
   * [
   *   ['step-a', 'step-b'],
   *   ['step-c', 'step-d']
   * ]
   *
   * The graph is expected to be validated before calling this function.
   */
export function buildDependencyLevels(nodes: readonly DependencyNode[]): string[][] {
    const remainingDependencyCounts = new Map<string, number>();
    const dependentIdsByNodeId = new Map<string, string[]>();
    
    for (const node of nodes) {
        remainingDependencyCounts.set(node.id, node.dependsOn.length);
        dependentIdsByNodeId.set(node.id, []);
    }

    for (const node of nodes) {
        for (const dependencyId of node.dependsOn) {
            const dependentIds = dependentIdsByNodeId.get(dependencyId);

            if (dependentIds !== undefined) {
                dependentIds.push(node.id);
            }
        }
    }

    let currentLevel = nodes.filter(node => remainingDependencyCounts.get(node.id) === 0).map(node => node.id);

    const levels: string[][] = [];
    let processedNodeCount = 0;

    while (currentLevel.length > 0) {
        levels.push(currentLevel);
        processedNodeCount += currentLevel.length;

        const nextLevel: string[] = [];

        for (const completedNodeId of currentLevel) {
            const dependentIds = dependentIdsByNodeId.get(completedNodeId) ?? [];

            for (const dependentId of dependentIds) {
                const remainingCount = (remainingDependencyCounts.get(dependentId) ?? 0) - 1;

                remainingDependencyCounts.set(dependentId, remainingCount);

                if (remainingCount === 0) {
                    nextLevel.push(dependentId);
                }
            }
        }

        currentLevel = nextLevel;
    }

    if (processedNodeCount !== nodes.length) {
        throw new Error('Cannot build execution levels because the dependency graph ' + 'contains circular or unresolved dependencies.');
    }

    return levels;
}
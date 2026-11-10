package main

import "time"

type TopologyGraph struct {
	Namespace   string         `json:"namespace"`
	GeneratedAt time.Time      `json:"generatedAt"`
	Nodes       []TopologyNode `json:"nodes"`
	Edges       []TopologyEdge `json:"edges"`
}

type TopologyNode struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	Namespace string         `json:"namespace,omitempty"`
	Name      string         `json:"name"`
	Status    string         `json:"status"`
	Detail    map[string]any `json:"detail,omitempty"`
}

type TopologyEdge struct {
	ID   string         `json:"id"`
	From string         `json:"from"`
	To   string         `json:"to"`
	Kind string         `json:"kind"`
	Meta map[string]any `json:"meta,omitempty"`
}

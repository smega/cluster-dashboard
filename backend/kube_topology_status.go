package main

import (
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
)

func genericReadyStatus(ready, desired int32) string {
	if desired == 0 {
		return "Idle"
	}
	if ready >= desired {
		return "Ready"
	}
	return "Progressing"
}

// func deploymentStatus(d *appsv1.Deployment) string {
// 	desired := int32(0)
// 	if d.Spec.Replicas != nil {
// 		desired = *d.Spec.Replicas
// 	}
// 	if desired == 0 {
// 		return "Idle"
// 	}
// 	if d.Status.UpdatedReplicas < desired || d.Status.ReadyReplicas < desired {
// 		return "Progressing"
// 	}
// 	return "Ready"
// }

func serviceStatus(s *corev1.Service) string {
	if s.Spec.Type == corev1.ServiceTypeLoadBalancer && len(s.Status.LoadBalancer.Ingress) == 0 {
		return "Provisioning"
	}
	return "Ready"
}

func ingressStatus(i *networkingv1.Ingress) string {
	if len(i.Status.LoadBalancer.Ingress) == 0 {
		return "Provisioning"
	}
	return "Ready"
}

func backendPortToAny(p networkingv1.ServiceBackendPort) any {
	if p.Name != "" {
		return p.Name
	}
	if p.Number != 0 {
		return p.Number
	}
	return nil
}

func lbAddresses(ing []corev1.LoadBalancerIngress) []string {
	out := make([]string, 0, len(ing))
	for _, i := range ing {
		if i.IP != "" {
			out = append(out, i.IP)
		} else if i.Hostname != "" {
			out = append(out, i.Hostname)
		}
	}
	return out
}

func ingressLBAddresses(ing []networkingv1.IngressLoadBalancerIngress) []string {
	out := make([]string, 0, len(ing))
	for _, i := range ing {
		if i.IP != "" {
			out = append(out, i.IP)
		} else if i.Hostname != "" {
			out = append(out, i.Hostname)
		}
	}
	return out
}

func containerStatus(name string, cs []corev1.ContainerStatus) string {
	for _, s := range cs {
		if s.Name != name {
			continue
		}
		if s.Ready {
			return "Ready"
		}
		if s.State.Waiting != nil && s.State.Waiting.Reason != "" {
			return s.State.Waiting.Reason
		}
		if s.State.Terminated != nil && s.State.Terminated.Reason != "" {
			return s.State.Terminated.Reason
		}
		return "NotReady"
	}
	return "Unknown"
}

func endpointReady(ep discoveryv1.Endpoint) bool {
	if ep.Conditions.Ready == nil {
		return true
	}
	return *ep.Conditions.Ready
}

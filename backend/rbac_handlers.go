// rbac_handlers.go
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ---------- Types for RBAC summary ----------

type RbacBindingSummary struct {
	BindingName string `json:"bindingName"`
	RoleKind    string `json:"roleKind"`
	RoleName    string `json:"roleName"`
}

type RbacSubjectSummary struct {
	Kind      string               `json:"kind"`                // User | Group | ServiceAccount
	Name      string               `json:"name"`                // alice, default
	Namespace string               `json:"namespace,omitempty"` // for ServiceAccount
	Bindings  []RbacBindingSummary `json:"bindings"`
}

type NameItem struct {
	Name string `json:"name"`
}

// ---------- Types for Role detail ----------

type RbacRuleDetail struct {
	APIGroups       []string `json:"apiGroups,omitempty"`
	Resources       []string `json:"resources,omitempty"`
	Verbs           []string `json:"verbs,omitempty"`
	ResourceNames   []string `json:"resourceNames,omitempty"`
	NonResourceURLs []string `json:"nonResourceURLs,omitempty"`
}

type RbacRoleDetail struct {
	Kind      string           `json:"kind"`
	Name      string           `json:"name"`
	Namespace string           `json:"namespace,omitempty"`
	Rules     []RbacRuleDetail `json:"rules"`
}

// ---------- Handlers ----------

// GET /api/rbac/namespaces
func rbacNamespacesHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	nsList, err := kubeClient.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list namespaces: %v", err)})
		return
	}

	names := make([]string, 0, len(nsList.Items))
	for _, ns := range nsList.Items {
		names = append(names, ns.Name)
	}
	sort.Strings(names)

	c.JSON(http.StatusOK, gin.H{"namespaces": names})
}

// GET /api/rbac/namespace/:namespace/summary
func rbacNamespaceSummaryHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	ns := c.Param("namespace")
	if ns == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing namespace"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	// RoleBindings in this namespace
	rbList, err := kubeClient.RbacV1().RoleBindings(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list rolebindings: %v", err)})
		return
	}

	// Roles in this namespace
	roleList, err := kubeClient.RbacV1().Roles(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list roles: %v", err)})
		return
	}

	// ClusterRoles (cluster-wide)
	crList, err := kubeClient.RbacV1().ClusterRoles().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list clusterroles: %v", err)})
		return
	}

	// Aggregate subjects from RoleBindings
	subjectMap := make(map[string]*RbacSubjectSummary)

	for _, rb := range rbList.Items {
		roleKind := rb.RoleRef.Kind
		if roleKind == "" {
			roleKind = "Role"
		}

		for _, s := range rb.Subjects {
			subNs := s.Namespace
			if s.Kind == "ServiceAccount" && subNs == "" {
				subNs = ns
			}
			key := s.Kind + "|" + s.Name + "|" + subNs
			ss, ok := subjectMap[key]
			if !ok {
				ss = &RbacSubjectSummary{
					Kind:      s.Kind,
					Name:      s.Name,
					Namespace: subNs,
				}
				subjectMap[key] = ss
			}
			ss.Bindings = append(ss.Bindings, RbacBindingSummary{
				BindingName: rb.Name,
				RoleKind:    roleKind,
				RoleName:    rb.RoleRef.Name,
			})
		}
	}

	// Convert map to slice and sort
	subjects := make([]RbacSubjectSummary, 0, len(subjectMap))
	for _, ss := range subjectMap {
		// sort bindings by roleKind/name for nice display
		sort.Slice(ss.Bindings, func(i, j int) bool {
			if ss.Bindings[i].RoleKind == ss.Bindings[j].RoleKind {
				return ss.Bindings[i].RoleName < ss.Bindings[j].RoleName
			}
			return ss.Bindings[i].RoleKind < ss.Bindings[j].RoleKind
		})
		subjects = append(subjects, *ss)
	}
	sort.Slice(subjects, func(i, j int) bool {
		if subjects[i].Kind == subjects[j].Kind {
			if subjects[i].Namespace == subjects[j].Namespace {
				return subjects[i].Name < subjects[j].Name
			}
			return subjects[i].Namespace < subjects[j].Namespace
		}
		return subjects[i].Kind < subjects[j].Kind
	})

	roles := make([]NameItem, 0, len(roleList.Items))
	for _, r := range roleList.Items {
		roles = append(roles, NameItem{Name: r.Name})
	}
	sort.Slice(roles, func(i, j int) bool { return roles[i].Name < roles[j].Name })

	clusterRoles := make([]NameItem, 0, len(crList.Items))
	for _, cr := range crList.Items {
		clusterRoles = append(clusterRoles, NameItem{Name: cr.Name})
	}
	sort.Slice(clusterRoles, func(i, j int) bool { return clusterRoles[i].Name < clusterRoles[j].Name })

	c.JSON(http.StatusOK, gin.H{
		"namespace":    ns,
		"subjects":     subjects,
		"roles":        roles,
		"clusterRoles": clusterRoles,
	})
}

// GET /api/rbac/role?kind=Role&namespace=ns&name=read-only
func rbacRoleDetailHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}

	kind := strings.TrimSpace(c.Query("kind"))
	name := strings.TrimSpace(c.Query("name"))
	ns := strings.TrimSpace(c.Query("namespace"))

	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing name"})
		return
	}
	if kind == "" {
		kind = "Role"
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	var rules []rbacv1.PolicyRule

	switch strings.ToLower(kind) {
	case "role":
		if ns == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "namespace required for Role"})
			return
		}
		role, err := kubeClient.RbacV1().Roles(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get role: %v", err)})
			return
		}
		rules = role.Rules
	case "clusterrole":
		cr, err := kubeClient.RbacV1().ClusterRoles().Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get clusterrole: %v", err)})
			return
		}
		rules = cr.Rules
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind must be Role or ClusterRole"})
		return
	}

	outRules := make([]RbacRuleDetail, 0, len(rules))
	for _, r := range rules {
		outRules = append(outRules, RbacRuleDetail{
			APIGroups:       r.APIGroups,
			Resources:       r.Resources,
			Verbs:           r.Verbs,
			ResourceNames:   r.ResourceNames,
			NonResourceURLs: r.NonResourceURLs,
		})
	}

	resp := RbacRoleDetail{
		Kind:      kind,
		Name:      name,
		Namespace: ns,
		Rules:     outRules,
	}
	c.JSON(http.StatusOK, resp)
}

type rbacBindingRequest struct {
	Namespace        string `json:"namespace"`
	SubjectKind      string `json:"subjectKind"`                // User | Group | ServiceAccount
	SubjectName      string `json:"subjectName"`                // alice, default
	SubjectNamespace string `json:"subjectNamespace,omitempty"` // for ServiceAccount
	RoleKind         string `json:"roleKind"`                   // Role | ClusterRole
	RoleName         string `json:"roleName"`
}

// POST /api/rbac/binding/add
func rbacAddBindingHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	var req rbacBindingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid json: %v", err)})
		return
	}

	req.Namespace = strings.TrimSpace(req.Namespace)
	req.SubjectKind = strings.TrimSpace(req.SubjectKind)
	req.SubjectName = strings.TrimSpace(req.SubjectName)
	req.SubjectNamespace = strings.TrimSpace(req.SubjectNamespace)
	req.RoleKind = strings.TrimSpace(req.RoleKind)
	req.RoleName = strings.TrimSpace(req.RoleName)

	if req.Namespace == "" || req.SubjectKind == "" || req.SubjectName == "" || req.RoleKind == "" || req.RoleName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing required fields"})
		return
	}

	// Default SA namespace to target namespace
	if strings.EqualFold(req.SubjectKind, "ServiceAccount") && req.SubjectNamespace == "" {
		req.SubjectNamespace = req.Namespace
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	rClient := kubeClient.RbacV1().RoleBindings(req.Namespace)

	// Build subject struct
	subject := rbacv1.Subject{
		Kind: req.SubjectKind,
		Name: req.SubjectName,
	}
	if strings.EqualFold(req.SubjectKind, "ServiceAccount") {
		subject.Namespace = req.SubjectNamespace
	} else {
		subject.APIGroup = "rbac.authorization.k8s.io"
	}

	roleKind := req.RoleKind
	if roleKind == "" {
		roleKind = "Role"
	}

	// Try to find existing RoleBinding with same RoleRef
	rbList, err := rClient.List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list rolebindings: %v", err)})
		return
	}

	for _, rb := range rbList.Items {
		if rb.RoleRef.Kind == roleKind && rb.RoleRef.Name == req.RoleName {
			// Check if subject already present
			for _, s := range rb.Subjects {
				if s.Kind == subject.Kind &&
					s.Name == subject.Name &&
					s.Namespace == subject.Namespace &&
					s.APIGroup == subject.APIGroup {
					c.JSON(http.StatusOK, gin.H{"status": "unchanged", "message": "binding already exists"})
					return
				}
			}
			// Append subject
			rb.Subjects = append(rb.Subjects, subject)
			if _, err := rClient.Update(ctx, &rb, metav1.UpdateOptions{}); err != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("update rolebinding: %v", err)})
				return
			}
			c.JSON(http.StatusOK, gin.H{"status": "updated", "bindingName": rb.Name})
			return
		}
	}

	// No existing RB with this RoleRef – create new one
	name := fmt.Sprintf("rb-%s-%s-%s-%s",
		strings.ToLower(roleKind),
		safeRBNamePart(req.RoleName),
		strings.ToLower(req.SubjectKind),
		safeRBNamePart(req.SubjectName),
	)

	newRB := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
		},
		RoleRef: rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     roleKind,
			Name:     req.RoleName,
		},
		Subjects: []rbacv1.Subject{subject},
	}

	if _, err := rClient.Create(ctx, newRB, metav1.CreateOptions{}); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("create rolebinding: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "created", "bindingName": name})
}

// POST /api/rbac/binding/remove
func rbacRemoveBindingHandler(c *gin.Context) {
	if kubeClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "kube client not initialized"})
		return
	}
	var req rbacBindingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid json: %v", err)})
		return
	}

	req.Namespace = strings.TrimSpace(req.Namespace)
	req.SubjectKind = strings.TrimSpace(req.SubjectKind)
	req.SubjectName = strings.TrimSpace(req.SubjectName)
	req.SubjectNamespace = strings.TrimSpace(req.SubjectNamespace)
	req.RoleKind = strings.TrimSpace(req.RoleKind)
	req.RoleName = strings.TrimSpace(req.RoleName)

	if req.Namespace == "" || req.SubjectKind == "" || req.SubjectName == "" || req.RoleKind == "" || req.RoleName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing required fields"})
		return
	}

	if strings.EqualFold(req.SubjectKind, "ServiceAccount") && req.SubjectNamespace == "" {
		req.SubjectNamespace = req.Namespace
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	rClient := kubeClient.RbacV1().RoleBindings(req.Namespace)

	// Subject to remove
	subject := rbacv1.Subject{
		Kind: req.SubjectKind,
		Name: req.SubjectName,
	}
	if strings.EqualFold(req.SubjectKind, "ServiceAccount") {
		subject.Namespace = req.SubjectNamespace
	} else {
		subject.APIGroup = "rbac.authorization.k8s.io"
	}

	roleKind := req.RoleKind
	if roleKind == "" {
		roleKind = "Role"
	}

	rbList, err := rClient.List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list rolebindings: %v", err)})
		return
	}

	for _, rb := range rbList.Items {
		if rb.RoleRef.Kind == roleKind && rb.RoleRef.Name == req.RoleName {
			// Filter out the subject
			newSubjects := rb.Subjects[:0]
			for _, s := range rb.Subjects {
				if s.Kind == subject.Kind &&
					s.Name == subject.Name &&
					s.Namespace == subject.Namespace &&
					s.APIGroup == subject.APIGroup {
					// skip this one (removing)
					continue
				}
				newSubjects = append(newSubjects, s)
			}
			// If unchanged, nothing to do
			if len(newSubjects) == len(rb.Subjects) {
				c.JSON(http.StatusOK, gin.H{"status": "unchanged", "message": "subject not found in binding"})
				return
			}
			// If binding has no subjects left, delete it
			if len(newSubjects) == 0 {
				if err := rClient.Delete(ctx, rb.Name, metav1.DeleteOptions{}); err != nil {
					c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("delete empty rolebinding: %v", err)})
					return
				}
				c.JSON(http.StatusOK, gin.H{"status": "deleted-binding", "bindingName": rb.Name})
				return
			}
			rb.Subjects = newSubjects
			if _, err := rClient.Update(ctx, &rb, metav1.UpdateOptions{}); err != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("update rolebinding: %v", err)})
				return
			}
			c.JSON(http.StatusOK, gin.H{"status": "updated", "bindingName": rb.Name})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"status": "unchanged", "message": "no matching rolebinding found"})
}

// helper to make a safe RoleBinding name fragment
func safeRBNamePart(s string) string {
	s = strings.ToLower(s)
	repl := func(r rune) rune {
		if (r >= 'a' && r <= 'z') ||
			(r >= '0' && r <= '9') ||
			r == '-' {
			return r
		}
		return '-'
	}
	return strings.Map(repl, s)
}

// Small compile-time guard: keep "errors" import used.
var _ = errors.New

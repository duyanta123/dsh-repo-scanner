package store

import "fmt"

type Store struct {
	name string
}

func New() *Store {
	return &Store{name: "go-app"}
}

func (s *Store) Open() error {
	_ = fmt.Sprintf
	return nil
}
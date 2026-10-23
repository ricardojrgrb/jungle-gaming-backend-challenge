-- Banco separado para a suíte de testes. Os testes rodam migrations e truncam
-- tabelas livremente, então nunca compartilham o banco da aplicação.
CREATE DATABASE wagering_test;

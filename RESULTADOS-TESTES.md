# FISIO IF — resultados de validação

Data: 11 de outubro de 2026

## Resultado

A versão 1.1.0 passou os testes automatizados executados neste ambiente.

- validação de sintaxe dos módulos da aplicação e do service worker;
- 13 testes de estrutura, base de dados, integridade de backups e criação de Excel: **13 aprovados, 0 falhados**;
- percurso integral num navegador Chromium em formato iPhone (390 × 844) e MacBook (1365 × 900);
- criação de pacientes, marcações, sessões, avaliações e movimentos financeiros;
- criação automática do movimento financeiro associado a uma sessão;
- exportação de backup integral, abertura numa base vazia e restauro com contagens iguais;
- exportação de um livro Excel `.xlsx` válido com seis folhas clínicas e administrativas;
- abertura independente do Excel, confirmação dos dados, estilos, datas, valores monetários e revisão visual de todas as folhas;
- recarregamento offline através do service worker.

## Dados do percurso automatizado

| Tipo | Antes do backup | Depois do restauro |
| --- | ---: | ---: |
| Pacientes | 4 | 4 |
| Marcações | 3 | 3 |
| Sessões | 2 | 2 |
| Avaliações | 2 | 2 |
| Movimentos financeiros | 4 | 4 |

## Limite desta validação

Não foi possível executar o teste final num iPhone físico nem no Safari do macOS neste computador Windows. Antes de usar dados reais, deve ser feito um ensaio com dados fictícios nos dois dispositivos, incluindo instalação pelo Safari, funcionamento offline, exportação JSON e Excel no iPhone e restauro do JSON no MacBook.


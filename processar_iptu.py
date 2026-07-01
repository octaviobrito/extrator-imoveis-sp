#!/usr/bin/env python3
"""
Processa o CSV do IPTU da Prefeitura de SP e gera um índice compacto
com apenas unidades de condomínio (que têm COMPLEMENTO preenchido).

Uso: python processar_iptu.py IPTU_2026.csv

Gera: iptu_condominios.json (índice compacto para a extensão)
"""
import csv
import json
import sys
import os
import re

# Tokens que indicam uma unidade de condomínio no COMPLEMENTO DO IMOVEL.
# Cobre condomínios verticais (AP/BL/COB) e horizontais/vilas (CASA/CS).
UNIDADE_RE = re.compile(
    r'\b(AP|APT|APTO|APARTAMENTO|BL|BLC|BLOCO|CS|CASA|CONJ|CJ|COB|COBERTURA|'
    r'LOJA|LJ|SL|SALA|SOBRELOJA|BOX|BX|GAR|GARAGEM|GALPAO|UNID|UNIDADE)\b',
    re.IGNORECASE
)

def normalizar_logradouro(nome):
    """Remove prefixos e acentos para normalização."""
    nome = nome.upper().strip()
    # Remove prefixos comuns
    nome = re.sub(
        r'^(RUA|R\.|R |AVENIDA|AV\.|AV |ALAMEDA|AL\.|AL |TRAVESSA|TV\.|TV |'
        r'PRACA|PCA\.|LARGO|VIELA|ESTRADA|ESTR\.|ESTR )\s*',
        '', nome
    )
    return nome.strip()

def extrair_sql(numero_contribuinte):
    """Extrai setor, quadra, lote, digito do número do contribuinte."""
    s = str(numero_contribuinte).strip()
    # Formato com pontos: 141.057.0001-3
    m = re.match(r'^(\d{3})\.(\d{3})\.(\d{4})-?(\d)?$', s)
    if m:
        return m.group(1), m.group(2), m.group(3), m.group(4) or '0'
    # Formato sem pontos: 0010030001-4 ou 00100300014 ou 0010030001
    m = re.match(r'^(\d{3})(\d{3})(\d{4})-?(\d)?$', s)
    if m:
        return m.group(1), m.group(2), m.group(3), m.group(4) or '0'
    return None, None, None, None

def main():
    if len(sys.argv) < 2:
        print("Uso: python processar_iptu.py IPTU_2026.csv")
        sys.exit(1)

    arquivo_csv = sys.argv[1]
    if not os.path.exists(arquivo_csv):
        print(f"Arquivo não encontrado: {arquivo_csv}")
        sys.exit(1)

    print(f"Processando {arquivo_csv}...")
    print("Isso pode levar alguns minutos para um arquivo de ~900MB.")

    # Índice: chave = "setor.quadra" -> lista de unidades
    indice = {}
    total = 0
    condos = 0
    erros = 0

    # Tenta detectar encoding
    encodings = ['utf-8', 'latin-1', 'cp1252']
    encoding_ok = None

    for enc in encodings:
        try:
            with open(arquivo_csv, 'r', encoding=enc) as f:
                f.readline()
            encoding_ok = enc
            break
        except UnicodeDecodeError:
            continue

    if not encoding_ok:
        encoding_ok = 'latin-1'
    print(f"Encoding detectado: {encoding_ok}")

    with open(arquivo_csv, 'r', encoding=encoding_ok) as f:
        reader = csv.DictReader(f, delimiter=';')

        for row in reader:
            total += 1
            if total % 500000 == 0:
                print(f"  {total:,} registros processados, {condos:,} unidades de condomínio...")

            complemento = (row.get('COMPLEMENTO DO IMOVEL') or '').strip()
            num_condo = (row.get('NUMERO DO CONDOMINIO') or '').strip()

            # Precisa ter complemento (ex: "BL 7 AP 124", "CASA 2 COND ...")
            if not complemento:
                continue

            # Manter registros que são unidades de condomínio. Um registro é
            # unidade quando:
            #  (a) tem NUMERO DO CONDOMINIO real (!= "00-0"), OU
            #  (b) o COMPLEMENTO denota claramente uma unidade (CASA/AP/BL/...).
            # A condição (b) é essencial para condomínios horizontais (vilas),
            # cujas casas às vezes têm NUMERO DO CONDOMINIO = "00-0" mas
            # complemento "CASA 2 COND RES ...". Sem ela, as casas ficavam de
            # fora do índice. Registros de faixa de endereço (ex: "E 53") não
            # casam com UNIDADE_RE e continuam excluídos.
            condo_real = bool(num_condo) and num_condo not in ('00-0', '0', '00', '000')
            if not (condo_real or UNIDADE_RE.search(complemento)):
                continue

            numero_contribuinte = (row.get('NUMERO DO CONTRIBUINTE') or '').strip()
            setor, quadra, lote, digito = extrair_sql(numero_contribuinte)

            if not setor or not quadra:
                erros += 1
                continue

            # Pular a entrada pai do condomínio (lote 0000)
            if lote == '0000':
                continue

            logradouro = (row.get('NOME DE LOGRADOURO DO IMOVEL') or '').strip()
            numero_imovel = (row.get('NUMERO DO IMOVEL') or '').strip()
            area_construida = (row.get('AREA CONSTRUIDA') or '').strip()
            tipo_uso = (row.get('TIPO DE USO DO IMOVEL') or '').strip()

            chave = f"{setor}.{quadra}"

            if chave not in indice:
                indice[chave] = []

            # Array compacto: [complemento, lote, digito, area_construida, numero_imovel]
            indice[chave].append([complemento, lote, digito, area_construida, numero_imovel])

            condos += 1

    print(f"\nResumo:")
    print(f"  Total de registros: {total:,}")
    print(f"  Unidades de condomínio: {condos:,}")
    print(f"  Endereços (setor.quadra): {len(indice):,}")
    print(f"  Erros de parsing: {erros:,}")

    # Salvar JSON compacto
    arquivo_saida = 'iptu_condominios.json'
    with open(arquivo_saida, 'w', encoding='utf-8') as f:
        json.dump(indice, f, ensure_ascii=False, separators=(',', ':'))

    tamanho = os.path.getsize(arquivo_saida)
    print(f"\nArquivo gerado: {arquivo_saida} ({tamanho / 1024 / 1024:.1f} MB)")
    print("\nPronto! Importe o arquivo na extensão pelo botão 'Importar dados IPTU'.")

if __name__ == '__main__':
    main()

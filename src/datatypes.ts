import { IValue, _IIndex, _ISelection, _IType } from './interfaces-private';
import { DataType, CastError, IType, QueryError } from './interfaces';
import moment from 'moment';
import hash from 'object-hash';
import { NotSupported } from './utils';
import { Evaluator, Value } from './valuetypes';
import { Query } from './query';

abstract class TypeBase<TRaw = any> implements _IType<TRaw> {

    abstract primary: DataType;
    doConvert?(value: Evaluator<TRaw>, to: _IType<TRaw>): Evaluator<any>;
    doCanConvert?(to: _IType<TRaw>): boolean;
    doEquals(a: any, b: any): boolean {
        return a === b;
    }

    doGt(a: any, b: any): boolean {
        return a > b;
    }

    doLt(a: any, b: any): boolean {
        return a < b;
    }
    toString(): string {
        throw new Error('Method not implemented.');
    }

    equals(a: TRaw, b: TRaw): boolean {
        if (a === null || b === null) {
            return false;
        }
        return this.doEquals(a, b);
    }

    gt(a: TRaw, b: TRaw): boolean {
        if (a === null || b === null) {
            return false;
        }
        return this.doGt(a, b);
    }
    lt(a: TRaw, b: TRaw): boolean {
        if (a === null || b === null) {
            return false;
        }
        return this.doLt(a, b);
    }

    canConvert(_to: DataType | _IType<TRaw>): boolean {
        const to = makeType(_to);
        if (to === this) {
            return true;
        }
        return this.doCanConvert && this.doCanConvert(to);
    }

    convert(a: IValue<TRaw>, _to: DataType | _IType<any>): IValue<any> {
        const to = makeType(_to);
        if (to === this) {
            return a;
        }
        if (!this.canConvert(to) || !this.doConvert || !(a instanceof Evaluator)) {
            throw new CastError(this.primary, to.primary);
        }
        const converted = this.doConvert(a, to);
        if (!converted) {
            throw new CastError(this.primary, to.primary);
        }
        if (a.isConstant) {
            if (typeof converted.val === 'function') {
                converted.val = converted.val(null);
            }
            if (converted.val === null) {
                return Value.null();
            }
        }
        return converted;
    }
}


class TimestampType extends TypeBase<moment.Moment> {

    get primary(): DataType {
        return DataType.timestamp;
    }


    doEquals(a: any, b: any): boolean {
        return moment(a).diff(moment(b)) < 0.1;
    }
    doGt(a: any, b: any): boolean {
        return moment(a).diff(moment(b)) > 0;
    }
    doLt(a: any, b: any): boolean {
        return moment(a).diff(moment(b)) < 0;
    }
}

class NullType extends TypeBase<null> {

    get primary(): DataType {
        return DataType.null;
    }

    doConvert(value: Evaluator<any>, to: _IType): Evaluator<any> {
        return new Evaluator(to, null, 'null', 'null', null, null);
    }

    doCanConvert(to: _IType): boolean {
        return true;
    }

    doEquals(a: any, b: any): boolean {
        return false;
    }

    doGt(a: any, b: any): boolean {
        return false;
    }

    doLt(a: any, b: any): boolean {
        return false;
    }
}

const integers = new Set([DataType.int, DataType.long]);
const numbers = new Set([DataType.int, DataType.long, DataType.decimal, DataType.float]);
class NumberType extends TypeBase<number> {
    constructor(readonly primary: DataType) {
        super();
    }

    canConvert(to: _IType) {
        switch (to.primary) {
            case DataType.int:
            case DataType.long:
            case DataType.float:
            case DataType.decimal:
                return true;
            default:
                return false;
        }
    }
    doConvert(value: Evaluator<any>, to: _IType): Evaluator<any> {
        if (!integers.has(value.type.primary) && integers.has(to.primary)) {
            return new Evaluator(to
                , value.id
                , value.sql
                , value.hash
                , value.selection
                , raw => {
                    const got = value.get(raw);
                    return typeof got === 'number'
                        ? Math.round(got)
                        : got;
                }
            );
        }
        return new Evaluator(to
            , value.id
            , value.sql
            , value.hash
            , value.selection
            , value.val
        );
    }
}

class TextType extends TypeBase<string> {

    get primary(): DataType {
        return DataType.text;
    }

    constructor(private len: number | null) {
        super();
    }

    doCanConvert(to: _IType): boolean {
        switch (to.primary) {
            case DataType.timestamp:
                return true;
            case DataType.text:
                return true;
        }
        if (numbers.has(to.primary)) {
            return true;
        }
    }

    doConvert(value: Evaluator<string>, to: _IType) {
        switch (to.primary) {
            case DataType.timestamp:
                return new Evaluator(Types.timestamp, value.id, value.sql, value.hash, value.selection, raw => {
                    const got = value.get(raw);
                    return moment(got);
                });
            case DataType.text:
                const fromStr = to as TextType;
                const toStr = to as TextType;
                if (toStr.len === null || fromStr.len < toStr.len) {
                    // no need to truncate
                    return value.setType(to);
                }
                return value
                    .setType(toStr)
                    .setValue(raw => {
                        const str: string = value.get(raw);
                        if (str.length > toStr.len) {
                            throw new QueryError(`value too long for type character varying(${toStr.len})`);
                        }
                        return str;
                    });
        }
        if (numbers.has(to.primary)) {
            const isInt = integers.has(to.primary);
            return value
                .setType(to)
                .setValue(raw => {
                    const str: string = value.get(raw);
                    if (str === null || str === undefined) {
                        return null;
                    }
                    const val = Number.parseFloat(str);
                    if (!Number.isFinite(val)) {
                        throw new QueryError(`invalid input syntax for ${to.primary}: ${str}`);
                    }
                    if (isInt && Math.floor(val) !== val) {
                        throw new QueryError(`invalid input syntax for ${to.primary}: ${str}`)
                    }
                    return val;
                })
        }
    }
}

class BoolType extends TypeBase<boolean> {
    get primary(): DataType {
        return DataType.bool;
    }
}

export class ArrayType extends TypeBase<any[]> {
    get primary(): DataType {
        return DataType.array;
    }

    constructor(readonly of: _IType) {
        super();
    }

    doCanConvert(to: _IType) {
        return to instanceof ArrayType
            && to.canConvert(this.of);
    }

    doConvert(value: IValue, _to: _IType) {
        const to = _to as ArrayType;
        const valueType = value.type as ArrayType;
        return new Evaluator(to
            , value.id
            , value.sql
            , value.hash
            , value.selection
            , raw => {
                const arr = value.get(raw) as any[];
                return arr.map(x => Value.constant(x, valueType.of).convert(to.of).get(raw));
            });
    }

    doEquals(a: any[], b: any[]): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!this.of.equals(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }

    doGt(a: any[], b: any[]): boolean {
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            if (this.of.gt(a[i], b[i])) {
                return true;
            }
        }
        return a.length > b.length;
    }

    doLt(a: any[], b: any[]): boolean {
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            if (this.of.lt(a[i], b[i])) {
                return true;
            }
        }
        return a.length < b.length;
    }

}

export function makeType(to: DataType | _IType<any>): _IType<any> {
    if (typeof to === 'string') {
        if (!Types[to]) {
            throw new Error('Unsupported raw type: ' + to);
        }
        return Types[to];
    }
    return to;
}

// type Ctors = {
//     [key in DataType]?: _IType;
// };
export const Types = { // : Ctors
    [DataType.bool]: new BoolType(),
    [DataType.text]: (len = null) => makeText(len),
    [DataType.timestamp]: new TimestampType(),
    [DataType.null]: new NullType(),
    [DataType.float]: new NumberType(DataType.float),
    [DataType.int]: new NumberType(DataType.int),
    [DataType.long]: new NumberType(DataType.long),
}

const texts = new Map<number, _IType>();
export function makeText(len: number = null) {
    len = len ?? null;
    let got = texts.get(len);
    if (!got) {
        texts.set(len, got = new TextType(len));
    }
    return got;
}

const arrays = new Map<_IType, _IType>();

export function makeArray(of: _IType): _IType {
    let got = arrays.get(of);
    if (got) {
        return got;
    }
    arrays.set(of, got = new ArrayType(of));
    return got;
}